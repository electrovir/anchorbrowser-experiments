import {type Page} from '@electrovir/rebrowser-playwright';

/** Shared, non-default (non-automation-looking) viewport applied by both runners. */
export const viewportSize = {
    width: 2560,
    height: 1335,
};

/** A live page handed to a task by a browser runner, tagged with which runner produced it. */
export type RunnerPage = Readonly<{
    page: Page;
    label: string;
    /**
     * Runs `trigger` (which must start a browser download) and persists the resulting file to disk,
     * returning the saved path. Each runner persists differently: local Playwright saves the
     * download directly, while Anchor Browser retrieves the file from remote session storage.
     */
    captureDownload: (trigger: () => Promise<void>) => Promise<string>;
}>;

/** Work to perform against a runner-provided {@link RunnerPage}. */
export type PageTask<T> = (runnerPage: RunnerPage) => Promise<T>;
