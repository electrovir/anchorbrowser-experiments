import {filterMap} from '@augment-vir/common';
import {readdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';

export const repoDirPath = resolve(import.meta.dirname, '..');
export const notCommittedDirPath = join(repoDirPath, '.not-committed');
export const secretsJsonPath = join(notCommittedDirPath, 'secrets.json');
export const playwrightUserDataDirPath = join(notCommittedDirPath, 'playwright-user-data');
export const downloadsDirPath = join(notCommittedDirPath, 'downloads');

/**
 * Output path for a file captured by a runner (e.g. `playwright-tsconfig.json`,
 * `anchor-tsconfig.json`).
 */
export function downloadOutputPath({
    label,
    fileName,
}: Readonly<{label: string; fileName: string}>): string {
    return join(downloadsDirPath, `${label}-${fileName}`);
}

/** Removes {@link downloadsDirPath} so each download run starts clean. */
export async function deleteDownloads(): Promise<void> {
    await rm(downloadsDirPath, {
        recursive: true,
        force: true,
    });
}

/** Screenshot output path for a given runner label (e.g. `anchor`, `fingerprint-playwright-seed`). */
export function screenshotPngPath(label: string): string {
    return join(notCommittedDirPath, `${label}.png`);
}

/** Deletes every screenshot (`.png`) in {@link notCommittedDirPath} so each run starts clean. */
export async function deleteScreenshots(): Promise<void> {
    const entries = await readdir(notCommittedDirPath).catch(() => []);
    const screenshotPaths = filterMap(
        entries,
        (entry) => join(notCommittedDirPath, entry),
        (path) => path.endsWith('.png'),
    );
    await Promise.all(screenshotPaths.map((path) => rm(path)));
}
