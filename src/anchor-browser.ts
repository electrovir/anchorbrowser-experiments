import {assert} from '@augment-vir/assert';
import {log, wait, type ArrayElement} from '@augment-vir/common';
import {Anchorbrowser} from 'anchorbrowser';
import {writeFile} from 'node:fs/promises';
import {defineShape, parseJsonWithShape} from 'object-shape-tester';
import {viewportSize, type PageTask} from './browser-runner.js';
import {downloadOutputPath} from './file-paths.js';
import {type SecretsClient} from './secrets.js';

const freeTier = false as boolean;

/**
 * Stable Anchor Browser profile name. Anchor identifies persistent profiles by name (rather than a
 * server-generated id), so reusing the same name across runs reuses the same stored cookies, local
 * storage, and cache.
 */
const anchorProfileName = 'anchorbrowser-experiments';

/**
 * Anchor's session-creation params. The SDK's generated `SessionCreateParams` type (v0.16.x) does
 * not model `browser.pdf_viewer`, which the REST API still accepts, so it is merged in here to keep
 * PDFs downloading (rather than rendering inline) so the session-downloads API captures them.
 */
type AnchorSessionConfig = Anchorbrowser.SessionCreateParams & {
    browser?:
        | {
              pdf_viewer?:
                  | {
                        active?: boolean | undefined;
                    }
                  | undefined;
          }
        | undefined;
};

/** A single file Anchor captured during a session, as returned by `sessions.retrieveDownloads`. */
type AnchorDownload = ArrayElement<
    NonNullable<NonNullable<Anchorbrowser.SessionRetrieveDownloadsResponse['data']>['items']>
>;

/**
 * The `data` payload returned by a download's `file_link`. It does not contain the file itself, but
 * a short-lived pre-signed S3 URL (`SignedUrl`) from which the bytes are fetched.
 */
const downloadFileLinkResponseShape = defineShape({
    data: {
        SignedUrl: '',
        status: '',
    },
});

/**
 * Polls Anchor's session-downloads API until the session has at least one captured file (the sync
 * happens asynchronously after the browser finishes downloading), then returns the file list.
 */
async function listAnchorDownloads({
    client,
    sessionId,
    attemptsLeft = 30,
}: Readonly<{
    client: Anchorbrowser;
    sessionId: string;
    attemptsLeft?: number;
}>): Promise<AnchorDownload[]> {
    const response = await client.sessions.retrieveDownloads(sessionId);
    const items = response.data?.items ?? [];

    if ((response.data?.count ?? 0) > 0 || attemptsLeft <= 1) {
        return items;
    }

    await wait({
        seconds: 1,
    });
    return await listAnchorDownloads({
        client,
        sessionId,
        attemptsLeft: attemptsLeft - 1,
    });
}

/**
 * Retrieves a single Anchor download's bytes. These stay raw `fetch` calls (rather than SDK
 * methods) because the SDK does not model retrieving a download's bytes: the api-key-protected
 * `file_link` does not return the file itself; it returns a JSON envelope containing a short-lived
 * pre-signed S3 URL, which is then fetched (unauthenticated) for the actual bytes.
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
    sessionId,
}: Readonly<{client: Anchorbrowser; sessionId: string}>): Promise<void> {
    log.faint(`Terminating Anchor Browser session ${sessionId}...`);
    await client.sessions.delete(sessionId);
}

export async function withAnchorBrowserPage<T>(
    secretsClient: Readonly<SecretsClient>,
    task: PageTask<T>,
): Promise<T> {
    const client = new Anchorbrowser({
        apiKey: secretsClient.get.apiKey,
    });

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

    const sessionResponse = await client.sessions.create(sessionConfig);
    const session = sessionResponse.data;
    assert.isDefined(session, 'Anchor Browser session creation returned no data.');
    assert.isDefined(session.id, 'Anchor Browser session creation returned no id.');
    assert.isDefined(session.cdp_url, 'Anchor Browser session creation returned no CDP url.');

    /** Captured so the narrowed (non-`undefined`) id stays typed inside the closures below. */
    const sessionId = session.id;

    log.faint(`Anchor Browser session created: ${sessionId}`);
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
                    sessionId,
                });
                if (!downloads.length) {
                    throw new Error(
                        'Anchor Browser reported no downloads; the download completed but never synced to session storage.',
                    );
                }

                const savedPaths = await Promise.all(
                    downloads.map(async (entry) => {
                        assert.isDefined(
                            entry.file_link,
                            'Anchor Browser download entry has no file link.',
                        );
                        const fileName = entry.suggested_file_name || entry.original_file_name;
                        assert.isDefined(
                            fileName,
                            'Anchor Browser download entry has no file name.',
                        );

                        const fileBytes = await fetchAnchorDownload({
                            apiKey: secretsClient.get.apiKey,
                            fileLink: entry.file_link,
                        });
                        const outputPath = downloadOutputPath({
                            label: 'anchor',
                            fileName,
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
            sessionId,
        }).catch((error: unknown) => log.error(error));
    }
}
