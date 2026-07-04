import {assert} from '@augment-vir/assert';
import {log, wait} from '@augment-vir/common';
import {RestVirClient} from '@rest-vir/api';
import {writeFile} from 'node:fs/promises';
import {parseJsonWithShape} from 'object-shape-tester';
import {
    anchorApi,
    createSessionEndpoint,
    downloadFileLinkResponseShape,
    endSessionEndpoint,
    listSessionDownloadsEndpoint,
    type AnchorDownload,
    type AnchorSessionConfig,
} from './anchor.api.js';
import {viewportSize, type PageTask} from './browser-runner.js';
import {downloadOutputPath} from './file-paths.js';
import {type SecretsClient} from './secrets.js';

const freeTier = false as boolean;

const anchorApiOrigin = 'https://api.anchorbrowser.io';

/**
 * Stable Anchor Browser profile name. Anchor identifies persistent profiles by name (rather than a
 * server-generated id), so reusing the same name across runs reuses the same stored cookies, local
 * storage, and cache.
 */
const anchorProfileName = 'anchorbrowser-experiments';

type AnchorClient = RestVirClient<typeof anchorApi>;

/**
 * Polls Anchor's session-downloads API until the session has at least one captured file (the sync
 * happens asynchronously after the browser finishes downloading), then returns the file list.
 */
async function listAnchorDownloads({
    client,
    apiKey,
    sessionId,
    attemptsLeft = 30,
}: Readonly<{
    client: AnchorClient;
    apiKey: string;
    sessionId: string;
    attemptsLeft?: number;
}>): Promise<AnchorDownload[]> {
    const result = await client.fetch(listSessionDownloadsEndpoint).GET({
        pathParams: {
            sessionId,
        },
        requiredHeaders: {
            'anchor-api-key': apiKey,
        },
    });
    if (result.unexpectedError) {
        throw new Error(
            `Anchor Browser downloads list failed: ${result.unexpectedError.status} ${result.unexpectedError.responseData || ''}.`,
        );
    }
    assert.isDefined(result.Ok, 'Anchor Browser downloads list returned no data.');

    if (result.Ok.responseData.data.count > 0 || attemptsLeft <= 1) {
        return result.Ok.responseData.data.items;
    }

    await wait({
        seconds: 1,
    });
    return await listAnchorDownloads({
        client,
        apiKey,
        sessionId,
        attemptsLeft: attemptsLeft - 1,
    });
}

/**
 * Retrieves a single Anchor download's bytes. Both requests stay raw `fetch` calls (rather than
 * `rest-vir` endpoints) because these are absolute URLs Anchor hands back per file, not fixed API
 * paths. The api-key-protected `file_link` does not return the file itself; it returns a JSON
 * envelope containing a short-lived pre-signed S3 URL, which is then fetched (unauthenticated) for
 * the actual bytes.
 */
async function fetchAnchorDownload({
    apiKey,
    fileLink,
}: Readonly<{apiKey: string; fileLink: string}>): Promise<Buffer> {
    const linkResponse = await fetch(fileLink, {
        headers: {
            'anchor-api-key': apiKey,
        },
    });
    if (!linkResponse.ok) {
        throw new Error(
            `Anchor Browser download link fetch failed: ${linkResponse.status} ${linkResponse.statusText}.`,
        );
    }
    const linkBody = parseJsonWithShape(await linkResponse.text(), downloadFileLinkResponseShape, {
        allowExtraKeys: true,
    });

    const fileResponse = await fetch(linkBody.data.SignedUrl);
    if (!fileResponse.ok) {
        throw new Error(
            `Anchor Browser download fetch failed: ${fileResponse.status} ${fileResponse.statusText}.`,
        );
    }
    return Buffer.from(await fileResponse.arrayBuffer());
}

/** Terminates the remote Anchor session so it does not stay alive until its idle timeout. */
async function endAnchorSession({
    client,
    apiKey,
    sessionId,
}: Readonly<{client: AnchorClient; apiKey: string; sessionId: string}>): Promise<void> {
    log.faint(`Terminating Anchor Browser session ${sessionId}...`);
    const result = await client.fetch(endSessionEndpoint).DELETE({
        pathParams: {
            sessionId,
        },
        requiredHeaders: {
            'anchor-api-key': apiKey,
        },
    });
    if (result.unexpectedError) {
        throw new Error(
            `Anchor Browser session termination failed: ${result.unexpectedError.status} ${result.unexpectedError.responseData || ''}.`,
        );
    }
}

export async function withAnchorBrowserPage<T>(
    secretsClient: Readonly<SecretsClient>,
    task: PageTask<T>,
): Promise<T> {
    const client: AnchorClient = new RestVirClient(anchorApi, anchorApiOrigin);

    log.faint('Creating Anchor Browser session...');
    const sessionConfig: AnchorSessionConfig = freeTier
        ? {}
        : {
              session: {
                  proxy: {
                      active: true,
                      type: 'anchor_proxy',
                      country_code: 'us',
                      region: 'CA',
                  },
              },
              browser: {
                  profile: {
                      name: anchorProfileName,
                      persist: true,
                  },
                  adblock: {
                      active: true,
                  },
                  popup_blocker: {
                      active: true,
                  },
                  extra_stealth: {
                      active: true,
                  },
                  /**
                   * Download files instead of rendering PDFs inline so the session-downloads API
                   * captures them.
                   */
                  pdf_viewer: {
                      active: false,
                  },
                  viewport: viewportSize,
              },
          };

    const sessionResult = await client.fetch(createSessionEndpoint).POST({
        requestData: sessionConfig,
        requiredHeaders: {
            'anchor-api-key': secretsClient.get.apiKey,
        },
    });
    if (sessionResult.unexpectedError) {
        throw new Error(
            `Anchor Browser session creation failed: ${sessionResult.unexpectedError.status} ${sessionResult.unexpectedError.responseData || ''}.`,
        );
    }
    const sessionSuccess = sessionResult.Ok ?? sessionResult.Created;
    assert.isDefined(sessionSuccess, 'Anchor Browser session creation returned no data.');

    const session = sessionSuccess.responseData.data;
    log.faint(`Anchor Browser session created: ${session.id}`);
    if (!freeTier) {
        log.faint(`Using Anchor Browser profile: ${anchorProfileName}`);
    }

    log.faint('Connecting via CDP...');
    const browser = await (
        await import('@electrovir/rebrowser-playwright')
    ).chromium.connectOverCDP(session.cdp_url);

    try {
        const context = browser.contexts()[0];
        assert.isDefined(context, 'Anchor Browser session returned no browser context.');

        const page = context.pages()[0];
        assert.isDefined(page, 'Anchor Browser session returned no page.');

        return await task({
            page,
            label: 'anchor',
            captureDownload: async (trigger) => {
                const [download] = await Promise.all([
                    page.waitForEvent('download', {
                        timeout: 30_000,
                    }),
                    trigger(),
                ]);
                log.faint(`Download started: ${download.suggestedFilename()}`);

                /**
                 * Wait for the download to actually finish on the remote browser before asking
                 * Anchor for it. `download.failure()` resolves once the download completes (`null`
                 * on success), so it surfaces a failed download (e.g. a proxy-blocked fetch) that
                 * would otherwise silently produce no captured file.
                 */
                const downloadFailure = await download.failure();
                if (downloadFailure) {
                    throw new Error(`Anchor Browser download did not complete: ${downloadFailure}`);
                }

                log.faint('Download complete; waiting for Anchor Browser to sync it to storage...');
                const downloads = await listAnchorDownloads({
                    client,
                    apiKey: secretsClient.get.apiKey,
                    sessionId: session.id,
                });
                if (!downloads.length) {
                    throw new Error(
                        'Anchor Browser reported no downloads; the download completed but never synced to session storage.',
                    );
                }

                const savedPaths = await Promise.all(
                    downloads.map(async (entry) => {
                        const fileBytes = await fetchAnchorDownload({
                            apiKey: secretsClient.get.apiKey,
                            fileLink: entry.file_link,
                        });
                        const outputPath = downloadOutputPath({
                            label: 'anchor',
                            fileName: entry.suggested_file_name || entry.original_file_name,
                        });
                        log.faint(`Saving Anchor Browser download to ${outputPath}...`);
                        await writeFile(outputPath, fileBytes);
                        return outputPath;
                    }),
                );
                return savedPaths.join(', ');
            },
        });
    } finally {
        await browser.close().catch((error: unknown) => log.error(error));
        await endAnchorSession({
            client,
            apiKey: secretsClient.get.apiKey,
            sessionId: session.id,
        }).catch((error: unknown) => log.error(error));
    }
}
