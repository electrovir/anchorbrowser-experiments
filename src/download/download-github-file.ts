import {log} from '@augment-vir/common';
import {type RunnerPage} from '../browser-runner.js';

export const githubRepoUrl = 'https://github.com/microsoft/playwright';
export const downloadFileName = 'tsconfig.json';

/**
 * Drives the GitHub UI to download a file: navigates to the repo, opens {@link downloadFileName},
 * clicks "Download raw file", and persists the download via the runner. Returns the saved path.
 */
export async function downloadGithubRawFile({
    page,
    label,
    captureDownload,
}: RunnerPage): Promise<string> {
    log.faint(`[${label}] Navigating to ${githubRepoUrl}...`);
    /**
     * Resolve as soon as the navigation commits rather than waiting for `domcontentloaded`: over
     * Anchor Browser's proxied/stealth session that event can lag past the timeout even though the
     * page is usable. The locator below auto-waits for the file link to actually appear.
     */
    await page.goto(githubRepoUrl, {
        waitUntil: 'commit',
    });

    log.faint(`[${label}] Opening ${downloadFileName}...`);
    /** GitHub's file-row link has an accessible name like `tsconfig.json, (File)`, so match loosely. */
    await page
        .getByRole('link', {
            name: downloadFileName,
        })
        .first()
        .click();

    log.faint(`[${label}] Clicking "Download raw file"...`);
    const savedPath = await captureDownload(() => page.getByTestId('download-raw-button').click());

    log.info(`[${label}] Saved download to ${savedPath}.`);
    return savedPath;
}
