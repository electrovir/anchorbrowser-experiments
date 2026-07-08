import {assert} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import {type Page} from '@electrovir/rebrowser-playwright';
import {buildUrl} from 'url-vir';
import {screenshotPngPath} from '../file-paths.js';

/**
 * The published first-party persistence test page. It exercises every browser storage mechanism as
 * a real page script; this automation only navigates it and reads the result it renders into the
 * DOM. Source: https://github.com/electrovir/browser-persistence-test.
 */
export const persistenceTestUrl = 'https://electrovir.github.io/browser-persistence-test/';

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

/** Drives the published test page in the given mode and returns the result it renders to the DOM. */
export async function runPersistencePage({
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
    const {href} = buildUrl(persistenceTestUrl, {
        search: {
            mode,
            marker,
        },
    });

    log.faint(`[${label}] Navigating to ${href} for the ${mode} run...`);
    await page.goto(href, {
        waitUntil: 'domcontentloaded',
    });

    log.faint(`[${label}] Waiting for the ${mode} run to complete...`);
    /**
     * Read the result JSON the page renders into the (open) shadow DOM of `<vir-app>` rather than a
     * `window` global: the stealth runner evaluates page functions in an isolated world where
     * page-set globals are invisible, but the DOM (including open shadow roots) is shared.
     */
    const resultHandle = await page.waitForFunction(
        () =>
            document.querySelector('vir-app')?.shadowRoot?.querySelector('pre')?.textContent ||
            undefined,
        undefined,
        {
            timeout: 60_000,
        },
    );

    const json = await resultHandle.jsonValue();
    assert.isString(json, `[${label}] the persistence page produced no result.`);
    const result = JSON.parse(json) as PersistenceRunResult;

    const screenshotPath = screenshotPngPath(`session-persist-${label}-${mode}`);
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
