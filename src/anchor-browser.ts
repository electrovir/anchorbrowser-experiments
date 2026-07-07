import {assert} from '@augment-vir/assert';
import {HttpMethod, log, wait} from '@augment-vir/common';
import {defineApi, defineEndpoint, HttpStatus, RestVirClient} from '@rest-vir/api';
import {writeFile} from 'node:fs/promises';
import {assertWrapValidShape, defineShape, nullableShape, unknownShape} from 'object-shape-tester';
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
 * Shape of the `POST /v1/sessions` request body. Only the fields these experiments set are modeled.
 * `session` and `browser` are nullable so the free-tier path (which sends `{}`) also validates.
 * `browser.pdf_viewer.active: false` forces PDFs to download (rather than render inline) so the
 * session-downloads API captures them.
 */
const anchorSessionCreateRequestShape = defineShape({
    session: nullableShape({
        proxy: nullableShape({
            active: true,
            type: '',
            country_code: '',
            region: nullableShape(''),
        }),
    }),
    browser: nullableShape({
        profile: {
            name: '',
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
        pdf_viewer: {
            active: true,
        },
        viewport: {
            width: 0,
            height: 0,
        },
    }),
});
type AnchorSessionConfig = typeof anchorSessionCreateRequestShape.runtimeType;

/**
 * A single file Anchor captured during a session, as listed by its session-downloads API. Every
 * field is optional because Anchor omits them depending on the file.
 */
const anchorDownloadShape = defineShape({
    id: nullableShape(''),
    file_link: nullableShape(''),
    suggested_file_name: nullableShape(''),
    original_file_name: nullableShape(''),
});
type AnchorDownload = typeof anchorDownloadShape.runtimeType;

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

const anchorSessionCreateEndpoint = defineEndpoint({
    path: '/v1/sessions',
    requests: {
        [HttpMethod.Post]: {
            requestData: anchorSessionCreateRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: defineShape({
                        data: {
                            id: '',
                            cdp_url: '',
                        },
                    }),
                },
            },
            clientOriginRequirement: {
                anyOrigin: true,
            },
        },
    },
});

const anchorSessionDownloadsEndpoint = defineEndpoint({
    path: '/v1/sessions/:sessionId/downloads',
    requests: {
        [HttpMethod.Get]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: defineShape({
                        data: nullableShape({
                            items: [
                                anchorDownloadShape,
                            ],
                        }),
                    }),
                },
            },
            clientOriginRequirement: {
                anyOrigin: true,
            },
        },
    },
});

const anchorSessionDeleteEndpoint = defineEndpoint({
    path: '/v1/sessions/:sessionId',
    requests: {
        [HttpMethod.Delete]: {
            responses: {
                /** The delete response body is intentionally ignored (`unknownShape`). */
                [HttpStatus.Ok]: {
                    responseData: unknownShape(),
                },
            },
            clientOriginRequirement: {
                anyOrigin: true,
            },
        },
    },
});

const anchorApiDefinition = defineApi({
    apiName: 'anchor-browser',
    endpoints: [
        anchorSessionCreateEndpoint,
        anchorSessionDownloadsEndpoint,
        anchorSessionDeleteEndpoint,
    ],
});

/**
 * Typed rest-vir client for Anchor's session API. These experiments only need session create /
 * delete / list-downloads, so a small API definition replaces the full Anchor SDK (which pulls in a
 * duplicate Playwright).
 */
const anchorApi = new RestVirClient(anchorApiDefinition, 'https://api.anchorbrowser.io');

/** The api-key header Anchor authenticates every session request with. */
function anchorAuthHeaders(apiKey: string) {
    return {
        'anchor-api-key': apiKey,
    };
}

/**
 * Polls Anchor's session-downloads API until the session has at least one captured file (the sync
 * happens asynchronously after the browser finishes downloading), then returns the file list.
 */
async function listAnchorDownloads({
    apiKey,
    sessionId,
    attemptsLeft = 30,
}: Readonly<{
    apiKey: string;
    sessionId: string;
    attemptsLeft?: number;
}>): Promise<AnchorDownload[]> {
    const result = await anchorApi.fetch(anchorSessionDownloadsEndpoint).GET({
        pathParams: {
            sessionId,
        },
        options: {
            headers: anchorAuthHeaders(apiKey),
        },
    });
    if (!result.Ok) {
        throw new Error(describeAnchorFailure('GET /v1/sessions/:sessionId/downloads', result));
    }
    const items = result.Ok.responseData.data?.items ?? [];

    if (items.length > 0 || attemptsLeft <= 1) {
        return items;
    }

    await wait({
        seconds: 1,
    });
    return await listAnchorDownloads({
        apiKey,
        sessionId,
        attemptsLeft: attemptsLeft - 1,
    });
}

/**
 * Retrieves a single Anchor download's bytes. Stays a raw `fetch` (rather than a rest-vir endpoint)
 * because `file_link` is an opaque, per-file URL and the bytes live on a different origin: the
 * api-key-protected `file_link` returns a JSON envelope containing a short-lived pre-signed S3 URL,
 * which is then fetched (unauthenticated) for the actual bytes.
 */
async function fetchAnchorDownload({
    apiKey,
    fileLink,
}: Readonly<{apiKey: string; fileLink: string}>): Promise<Buffer> {
    const linkResponse = await fetch(fileLink, {
        headers: anchorAuthHeaders(apiKey),
    });
    if (!linkResponse.ok) {
        throw new Error(
            `Anchor Browser download link fetch failed: ${linkResponse.status} ${linkResponse.statusText}.`,
        );
    }
    const linkBody = assertWrapValidShape(
        await linkResponse.json(),
        downloadFileLinkResponseShape,
        {
            allowExtraKeys: true,
        },
        'Anchor Browser download link response did not match the expected shape.',
    );

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
    apiKey,
    sessionId,
}: Readonly<{apiKey: string; sessionId: string}>): Promise<void> {
    log.faint(`Terminating Anchor Browser session ${sessionId}...`);
    await anchorApi.fetch(anchorSessionDeleteEndpoint).DELETE({
        pathParams: {
            sessionId,
        },
        options: {
            headers: anchorAuthHeaders(apiKey),
        },
    });
}

export async function withAnchorBrowserPage<T>(
    secretsClient: Readonly<SecretsClient>,
    task: PageTask<T>,
): Promise<T> {
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

    const createResult = await anchorApi.fetch(anchorSessionCreateEndpoint).POST({
        requestData: sessionConfig,
        options: {
            headers: anchorAuthHeaders(secretsClient.get.apiKey),
        },
    });
    if (!createResult.Ok) {
        throw new Error(describeAnchorFailure('POST /v1/sessions', createResult));
    }
    const sessionId = createResult.Ok.responseData.data.id;

    log.faint(`Anchor Browser session created: ${sessionId}`);
    if (!freeTier) {
        log.faint(`Using Anchor Browser profile: ${anchorProfileName}`);
    }

    log.faint('Connecting via CDP...');
    const browser = await (
        await import('@electrovir/rebrowser-playwright')
    ).chromium.connectOverCDP(createResult.Ok.responseData.data.cdp_url);

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
                    apiKey: secretsClient.get.apiKey,
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
            apiKey: secretsClient.get.apiKey,
            sessionId,
        }).catch((error: unknown) => log.error(error));
    }
}

function describeAnchorFailure(
    endpoint: string,
    result: Readonly<{unexpectedError?: {response: Response; responseData: unknown} | undefined}>,
) {
    const response = result.unexpectedError?.response;
    const data = result.unexpectedError?.responseData;
    return [
        'Anchor Browser API call failed for',
        endpoint,
        '-',
        response ? String(response.status) : '',
        response?.statusText || '',
        data ? JSON.stringify(data) : '',
    ]
        .filter(Boolean)
        .join(' ');
}
