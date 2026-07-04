import {type ArrayElement} from '@augment-vir/common';
import {defineApi, defineEndpoint, HttpMethod, HttpStatus} from '@rest-vir/api';
import {
    defineShape,
    nullableShape,
    partialShape,
    recordShape,
    unknownShape,
} from 'object-shape-tester';

/**
 * The complete Anchor Browser session-creation request body. Every property is optional: Anchor
 * applies its own defaults for anything omitted (so a free-tier run can create a bare default
 * session with an empty body). See
 * https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session.
 */
const sessionConfigShape = partialShape({
    session: partialShape({
        initial_url: '',
        tags: [
            '',
        ],
        recording: partialShape({
            active: true,
        }),
        proxy: partialShape({
            /** `anchor_proxy` (Anchor's pool) or `custom` (bring-your-own via `server`/credentials). */
            type: '',
            active: true,
            country_code: '',
            region: '',
            city: '',
            server: '',
            username: '',
            password: '',
        }),
        timeout: partialShape({
            max_duration: 0,
            idle_timeout: 0,
        }),
        live_view: partialShape({
            read_only: true,
            one_time_url: true,
        }),
    }),
    browser: partialShape({
        profile: partialShape({
            name: '',
            persist: true,
        }),
        adblock: partialShape({
            active: true,
        }),
        popup_blocker: partialShape({
            active: true,
        }),
        captcha_solver: partialShape({
            active: true,
        }),
        headless: partialShape({
            active: true,
        }),
        viewport: partialShape({
            width: 0,
            height: 0,
        }),
        fullscreen: partialShape({
            active: true,
        }),
        pdf_viewer: partialShape({
            active: true,
        }),
        p2p_download: partialShape({
            active: true,
        }),
        extensions: [
            '',
        ],
        disable_web_security: partialShape({
            active: true,
        }),
        extra_stealth: partialShape({
            active: true,
        }),
        force_popups_as_tabs: partialShape({
            active: true,
        }),
        web_bot_auth: partialShape({
            active: true,
        }),
        disable_dialogs: partialShape({
            active: true,
        }),
        ca_cert: partialShape({
            active: true,
            name: '',
        }),
        tracing: partialShape({
            active: true,
            snapshots: true,
            sources: true,
        }),
        sensitive_data_mask: partialShape({
            active: true,
            custom_selectors: [
                '',
            ],
            site_selectors: recordShape({
                keys: '',
                values: [
                    '',
                ],
            }),
            custom_patterns: [
                partialShape({
                    regex: '',
                    mask: '',
                }),
            ],
        }),
    }),
    integrations: [
        partialShape({
            id: '',
            type: '',
            configuration: unknownShape(),
        }),
    ],
    identities: [
        {
            id: '',
        },
    ],
});

/** The complete `data` payload returned when an Anchor session is created. */
const sessionResponseShape = defineShape({
    data: {
        id: '',
        cdp_url: '',
        live_view_url: nullableShape(''),
    },
});

/** The complete `data` payload returned by Anchor's session-downloads listing. */
const downloadsResponseShape = defineShape({
    data: {
        count: 0,
        items: [
            {
                id: '',
                file_link: '',
                suggested_file_name: '',
                original_file_name: '',
                original_download_url: nullableShape(''),
                origin_url: nullableShape(''),
                duration: nullableShape(0),
                size: nullableShape(0),
                created_at: nullableShape(''),
            },
        ],
    },
});

/**
 * The complete `data` payload returned by a download's `file_link`. It does not contain the file
 * itself, but a short-lived pre-signed S3 URL (`SignedUrl`) from which the bytes are fetched.
 */
export const downloadFileLinkResponseShape = defineShape({
    data: {
        SignedUrl: '',
        status: '',
    },
});

/** The complete `data` payload returned when an Anchor session is terminated. */
const endSessionResponseShape = defineShape({
    data: {
        status: '',
    },
});

/** Every Anchor REST call authenticates with this header. */
const anchorApiKeyHeader = {
    'anchor-api-key': defineShape(''),
};

export const createSessionEndpoint = defineEndpoint({
    path: '/v1/sessions',
    requests: {
        [HttpMethod.Post]: {
            requestData: sessionConfigShape,
            requiredRequestHeaders: anchorApiKeyHeader,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: sessionResponseShape,
                },
                [HttpStatus.Created]: {
                    responseData: sessionResponseShape,
                },
            },
        },
    },
});

export const listSessionDownloadsEndpoint = defineEndpoint({
    path: '/v1/sessions/:sessionId/downloads',
    requests: {
        [HttpMethod.Get]: {
            requiredRequestHeaders: anchorApiKeyHeader,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: downloadsResponseShape,
                },
            },
        },
    },
});

export const endSessionEndpoint = defineEndpoint({
    path: '/v1/sessions/:sessionId',
    requests: {
        [HttpMethod.Delete]: {
            requiredRequestHeaders: anchorApiKeyHeader,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: endSessionResponseShape,
                },
            },
        },
    },
});

export const anchorApi = defineApi({
    apiName: 'anchor-browser',
    endpoints: [
        createSessionEndpoint,
        listSessionDownloadsEndpoint,
        endSessionEndpoint,
    ],
    webSockets: [],
});

/** The request body accepted by {@link createSessionEndpoint}. */
export type AnchorSessionConfig = (typeof sessionConfigShape)['runtimeType'];

/**
 * A single file Anchor captured during a session, as returned by
 * {@link listSessionDownloadsEndpoint}.
 */
export type AnchorDownload = ArrayElement<
    (typeof downloadsResponseShape)['runtimeType']['data']['items']
>;
