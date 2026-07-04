import {assert} from '@augment-vir/assert';
import {log, wait} from '@augment-vir/common';
import {type Page} from '@electrovir/rebrowser-playwright';

export const botDetectorUrl = 'https://bot-detector.rebrowser.net/';

/**
 * Drives `page` through the rebrowser bot detector: navigates, registers the exposed function (its
 * binding survives navigation), reopens the page, fires the evaluate-based triggers, waits for the
 * detector to render its verdict, then saves a screenshot.
 */
export async function runBotDetector({
    page,
    screenshotPngPath,
}: Readonly<{page: Page; screenshotPngPath: string}>): Promise<void> {
    log.faint(`Navigating to ${botDetectorUrl}...`);
    const response = await page.goto(botDetectorUrl, {
        waitUntil: 'load',
    });
    assert.isDefined(response, `No response received when navigating to '${botDetectorUrl}'.`);
    assert.isTrue(
        response.ok(),
        `Navigation to '${botDetectorUrl}' failed with status ${response.status()}.`,
    );

    /** `exposeFunction`'s binding persists across navigation, so register it then reopen the page. */
    await page.exposeFunction('exposedFn', () => undefined);
    await page.goto(botDetectorUrl, {
        waitUntil: 'load',
    });

    /**
     * DummyFn -> main-context execution; getElementById -> sourceUrl leak; getElementsByClassName
     * -> main-world execution.
     */
    await page.evaluate('window.dummyFn && void window.dummyFn()');
    await page.evaluate("void document.getElementById('detections-json')");
    await page.evaluate("void document.getElementsByClassName('div')");

    /** Give the detector time to run its checks and render the verdict before capturing it. */
    await wait({
        seconds: 5,
    });

    log.faint(`Writing screenshot to ${screenshotPngPath}...`);
    await page.screenshot({
        path: screenshotPngPath,
        fullPage: true,
    });
}
