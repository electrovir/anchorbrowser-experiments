import {log, wait} from '@augment-vir/common';
import {type Page} from '@electrovir/rebrowser-playwright';

export async function navigateAndScreenshot({
    page,
    url,
    screenshotPngPath,
}: Readonly<{page: Page; url: string; screenshotPngPath: string}>) {
    log.faint(`Navigating to ${url}...`);
    const response = await page
        .goto(url, {
            waitUntil: 'domcontentloaded',
        })
        .catch(() => {
            log.warning(
                `Navigation to '${url}' did not finish loading in time; capturing the page as-is.`,
            );
            return undefined;
        });
    if (response && !response.ok()) {
        log.warning(`Navigation to '${url}' returned status ${response.status()}.`);
    }

    await wait({
        seconds: 5,
    });

    log.faint(`Writing screenshot to ${screenshotPngPath}...`);
    await page.screenshot({
        path: screenshotPngPath,
        fullPage: true,
    });
    log.info(`Page title: ${await page.title()}`);
}
