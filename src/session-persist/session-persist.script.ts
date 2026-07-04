import {assert, check} from '@augment-vir/assert';
import {
    awaitedBlockingMap,
    combineErrors,
    ensureErrorAndPrependMessage,
    filterMap,
    log,
    wait,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {randomUUID} from 'node:crypto';
import {withAnchorBrowserPage} from '../anchor-browser.js';
import {type PageTask} from '../browser-runner.js';
import {withPlaywrightPage} from '../playwright.js';
import {createSecretsClient} from '../secrets.js';
import {PersistenceMode, runPersistencePage, type PersistenceRunResult} from './session-persist.js';

type RunTask = <Result>(task: PageTask<Result>) => Promise<Result>;

type RunnerOutcome = Readonly<{
    name: string;
    result: PersistenceRunResult | undefined;
    error: Error | undefined;
}>;

/**
 * Drives the published persistence test page in one session (seed), then opens a completely
 * separate session (reusing the same persistent profile/user-data-dir) and reads it back (verify).
 */
async function checkPersistence({
    name,
    runTask,
}: Readonly<{name: string; runTask: RunTask}>): Promise<PersistenceRunResult> {
    const marker = randomUUID();
    log.info(`[${name}] Seeding session state with marker ${marker}...`);
    await runTask(({page, label}) =>
        runPersistencePage({
            page,
            label,
            mode: PersistenceMode.Seed,
            marker,
        }),
    );

    /**
     * Anchor Browser flushes a profile to storage when its session ends, so give it a moment before
     * opening a fresh session against the same profile. Harmless for local Playwright.
     */
    await wait({
        seconds: 3,
    });

    log.info(`[${name}] Verifying session state in a brand-new session...`);
    return await runTask(({page, label}) =>
        runPersistencePage({
            page,
            label,
            mode: PersistenceMode.Verify,
            marker,
        }),
    );
}

function logSummary(outcomes: ReadonlyArray<RunnerOutcome>): void {
    const lines = outcomes.flatMap(({name, result, error}) => {
        if (error) {
            return [`[${name}] failed: ${error.message}`];
        }
        assert.isDefined(result, `${name} produced neither a result nor an error.`);
        const labelWidth = Math.max(...result.reports.map((report) => report.label.length));
        return [
            `[${name}] session persistence:`,
            ...result.reports.map((report) => {
                const label = report.label.padEnd(labelWidth);
                const detail = !report.ok && report.error ? ` (${report.error})` : '';
                return `  ${label}  ${report.ok ? '✅' : '❌'}${detail}`;
            }),
        ];
    });
    log.info(lines.join('\n'));
}

async function main() {
    const secretsClient = await createSecretsClient();

    const runners: ReadonlyArray<Readonly<{name: string; runTask: RunTask}>> = [
        {
            name: 'anchor',
            runTask: (task) => withAnchorBrowserPage(secretsClient, task),
        },
        {
            name: 'playwright',
            runTask: withPlaywrightPage,
        },
    ];

    try {
        const outcomes = await awaitedBlockingMap(
            runners,
            async ({name, runTask}): Promise<RunnerOutcome> => {
                const result = await checkPersistence({
                    name,
                    runTask,
                }).catch((error: unknown) => {
                    log.error(error);
                    return ensureErrorAndPrependMessage(error, `${name} runner failed`);
                });
                return check.isError(result)
                    ? {
                          name,
                          result: undefined,
                          error: result,
                      }
                    : {
                          name,
                          result,
                          error: undefined,
                      };
            },
        );

        logSummary(outcomes);

        /**
         * Only actual runner failures are fatal. A mechanism not persisting is a valid, expected
         * result to observe (e.g. sessionStorage rarely survives across separate sessions), so the
         * per-mechanism summary above is the deliverable rather than a pass/fail gate.
         */
        const errors = filterMap(
            outcomes,
            (outcome) => outcome.error,
            (mapped): mapped is Error => check.isError(mapped),
        );
        if (errors.length) {
            throw combineErrors(errors);
        }

        log.success('Session persistence comparison complete for every runner.');
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
