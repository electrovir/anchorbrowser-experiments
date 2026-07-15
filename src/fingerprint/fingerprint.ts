import {assert} from '@augment-vir/assert';
import {log, wait} from '@augment-vir/common';
import {type Page} from '@electrovir/rebrowser-playwright';
import {buildUrl} from 'url-vir';
import {screenshotPngPath} from '../file-paths.js';

/**
 * The published first-party browser-tests page. It rolls the persistence, rebrowser bot-detection,
 * OS-fingerprint, and are-you-a-bot suites into one page that runs entirely as real page scripts;
 * this automation only navigates it, fires the rebrowser evaluate-based triggers, and reads the
 * result it renders into the DOM. Source: https://github.com/electrovir/browser-tests.
 */
export const browserTestsUrl = 'https://electrovir.github.io/browser-tests/';

export enum PersistenceMode {
    Seed = 'seed',
    Verify = 'verify',
}

/** One storage mechanism's outcome, mirroring the test page's JSON output. */
export type MechanismReport = Readonly<{
    mechanism: string;
    label: string;
    /** Seed run: written without error. Verify run: read back successfully (i.e. it persisted). */
    ok: boolean;
    error?: string | undefined;
}>;

export type PersistenceEnvironment = Readonly<{
    persistentStorage?: boolean | undefined;
    quotaBytes?: number | undefined;
    usageBytes?: number | undefined;
}>;

export type PersistenceRunResult = Readonly<{
    mode: string;
    marker: string;
    environment: PersistenceEnvironment;
    reports: ReadonlyArray<MechanismReport>;
}>;

/**
 * Drives the combined browser-tests page in the given persistence mode: fires the rebrowser
 * automation-detection triggers (whose verdicts, alongside the OS-fingerprint and are-you-a-bot
 * panels, land in the screenshot) and returns the persistence result the page renders into the
 * DOM.
 */
export async function runFingerprintPage({
    page,
    label,
    mode,
    marker,
}: Readonly<{
    page: Page;
    label: string;
    mode: PersistenceMode;
    marker: string;
}>): Promise<PersistenceRunResult> {
    const {href} = buildUrl(browserTestsUrl, {
        search: {
            mode,
            marker,
        },
    });

    log.faint(`[${label}] Navigating to ${href} for the ${mode} run...`);
    await page.goto(href, {
        waitUntil: 'load',
    });

    /** `exposeFunction`'s binding persists across navigation, so register it then reopen the page. */
    await page.exposeFunction('exposedFn', () => undefined);
    await page.goto(href, {
        waitUntil: 'load',
    });

    /**
     * DummyFn -> main-world object access; getElementById -> sourceUrl leak; getElementsByClassName
     * -> main-world execution. Each only trips its rebrowser detection when the runner is
     * unpatched.
     */
    await page.evaluate('window.dummyFn && void window.dummyFn()');
    await page.evaluate("void document.getElementById('detections-json')");
    await page.evaluate("void document.getElementsByClassName('div')");

    log.faint(`[${label}] Waiting for the ${mode} run to complete...`);
    /**
     * Read the persistence result JSON from the (open) shadow DOM rather than a `window` global:
     * the stealth runner evaluates page functions in an isolated world where page-set globals are
     * invisible, but the DOM (including open shadow roots) is shared.
     */
    const resultHandle = await page.waitForFunction(
        () =>
            document
                .querySelector('vir-app')
                ?.shadowRoot?.querySelector('vir-persistence-tests')
                ?.shadowRoot?.querySelector('pre.json')?.textContent || undefined,
        undefined,
        {
            timeout: 60_000,
        },
    );

    const json = await resultHandle.jsonValue();
    assert.isString(json, `[${label}] the browser-tests page produced no persistence result.`);
    const result = JSON.parse(json) as PersistenceRunResult;

    /**
     * Wait for the OS-fingerprint and are-you-a-bot panels to render their verdicts (their audio
     * render, web-worker, and permission probes are the slowest sections) so the screenshot
     * captures results rather than the "Running…" state. Falls back to capturing as-is if they
     * stall (e.g. no network).
     */
    await page
        .waitForFunction(
            () => {
                const appRoot = document.querySelector('vir-app')?.shadowRoot;
                const fingerprintReady =
                    appRoot
                        ?.querySelector('vir-os-fingerprint-tests')
                        ?.shadowRoot?.querySelector('.user-agent') != undefined;
                const areYouABotReady =
                    appRoot
                        ?.querySelector('vir-are-you-a-bot-tests')
                        ?.shadowRoot?.querySelector('.verdict') != undefined;
                return fingerprintReady && areYouABotReady;
            },
            undefined,
            {
                timeout: 30_000,
            },
        )
        .catch(() => {
            log.warning(
                `[${label}] OS fingerprint or are-you-a-bot panel did not finish rendering in time; capturing as-is.`,
            );
        });

    /**
     * Give the rebrowser detections that resolve asynchronously (the CSP-bypass probe, the CDP
     * Runtime.enable probe, and the Chrome-version fetches) time to settle before capturing.
     */
    await wait({
        seconds: 5,
    });

    const screenshotPath = screenshotPngPath(`fingerprint-${label}-${mode}`);
    log.faint(`[${label}] Writing ${mode} screenshot to ${screenshotPath}...`);
    await page.screenshot({
        path: screenshotPath,
        fullPage: true,
    });

    result.reports.forEach((report) => {
        if (report.error) {
            log.warning(`[${label}] ${mode} run — ${report.label} error: ${report.error}`);
        }
    });

    return result;
}
