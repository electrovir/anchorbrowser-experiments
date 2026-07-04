import {check} from '@augment-vir/assert';
import {
    combineErrors,
    ensureErrorAndPrependMessage,
    log,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {mkdir} from 'node:fs/promises';
import {withAnchorBrowserPage} from '../anchor-browser.js';
import {type PageTask} from '../browser-runner.js';
import {deleteDownloads, downloadsDirPath} from '../file-paths.js';
import {withPlaywrightPage} from '../playwright.js';
import {createSecretsClient} from '../secrets.js';
import {downloadGithubRawFile} from './download-github-file.js';

async function main() {
    await deleteDownloads();
    await mkdir(downloadsDirPath, {
        recursive: true,
    });

    const secretsClient = await createSecretsClient();

    const downloadTask: PageTask<string> = downloadGithubRawFile;

    try {
        const outcomes = [
            await withAnchorBrowserPage(secretsClient, downloadTask).catch((error: unknown) => {
                log.error(error);
                return ensureErrorAndPrependMessage(error, 'Anchor Browser failed');
            }),
            await withPlaywrightPage(downloadTask).catch((error: unknown) => {
                log.error(error);
                return ensureErrorAndPrependMessage(error, 'Raw Playwright failed');
            }),
        ];

        const savedPaths = outcomes.filter(check.isString);
        if (savedPaths.length) {
            log.success(
                [
                    'Saved downloads:',
                    ...savedPaths,
                ].join('\n'),
            );
        }

        const errors = outcomes.filter((outcome): outcome is Error => check.isError(outcome));
        if (errors.length) {
            throw combineErrors(errors);
        }
    } finally {
        secretsClient.destroy();
    }
}

try {
    await wrapPromiseInTimeout(
        {
            minutes: 5,
        },
        main(),
    );
    process.exit(0);
} catch (error) {
    log.error(error);
    process.exit(1);
}
