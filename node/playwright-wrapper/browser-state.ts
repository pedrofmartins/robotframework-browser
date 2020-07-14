import { sendUnaryData, ServerUnaryCall } from 'grpc';
import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright';

import { Response, Request } from './generated/playwright_pb';
import { invokeOnPage, exists } from './playwirght-util';
import { emptyWithLog } from './response-util';

async function _newBrowser(
    browserType?: string,
    headless?: boolean,
    options?: Record<string, unknown>,
): Promise<[string, Browser]> {
    browserType = browserType || 'chromium';
    headless = headless || true;
    let browser;
    if (browserType === 'firefox') {
        browser = await firefox.launch({ headless: headless, ...options });
    } else if (browserType === 'chromium') {
        browser = await chromium.launch({ headless: headless, ...options });
    } else if (browserType === 'webkit') {
        browser = await webkit.launch({ headless: headless, ...options });
    } else {
        throw new Error('unsupported browser');
    }
    return [browserType, browser];
}

async function _newBrowserContext(browser: Browser, hideRfBrowser?: boolean): Promise<BrowserContext> {
    const context = await browser.newContext();
    if (!hideRfBrowser) {
        context.addInitScript(function () {
            window.__SET_RFBROWSER_STATE__ = function (state: any) {
                window.__RFBROWSER__ = state;
                return state;
            };
        });
    }
    context.setDefaultTimeout(parseFloat(process.env.TIMEOUT || '10000'));
    return context;
}

async function initializeBrowser(browserState: BrowserState): Promise<Browser> {
    if (browserState.browser) {
        return browserState.browser;
    } else {
        const [name, browser] = await _newBrowser();
        browserState.browser = browser;
        browserState.name = name;
        return browser;
    }
}

async function initializeContext(browserState: BrowserState): Promise<BrowserContext> {
    if (browserState?.context) {
        return browserState.context;
    } else {
        if (!browserState?.browser) {
            await initializeBrowser(browserState);
        }
        const browser = browserState.browser;
        const context = await _newBrowserContext(browser!);
        browserState.context = context;
        return context;
    }
}

export class BrowserState {
    constructor(browser?: Browser, context?: BrowserContext, page?: Page, name?: string) {
        this.browser = browser;
        this.context = context;
        this.page = page;
        this.name = name;
    }
    browser?: Browser;
    context?: BrowserContext;
    page?: Page;
    name?: string;
}

export async function closeBrowser(callback: sendUnaryData<Response.Empty>, browserState: BrowserState) {
    exists(browserState?.browser, callback, 'Tried to close browser but none was open');
    await browserState.browser.close();
    browserState.context = undefined;
    browserState.page = undefined;
}

export async function createPage(
    call: ServerUnaryCall<Request.Url>,
    callback: sendUnaryData<Response.Empty>,
    browserState: BrowserState,
): Promise<void> {
    const context = await initializeContext(browserState);

    const page = await context?.newPage();
    browserState.page = page;
    const url = call.request.getUrl() || 'about:blank';
    await invokeOnPage(page, callback, 'goto', url, { timeout: 10000 });
    callback(null, emptyWithLog('Succesfully initialized new page object and opened url'));
}

export async function createContext(
    call: ServerUnaryCall<Request.Context>,
    callback: sendUnaryData<Response.Empty>,
    browserState: BrowserState,
): Promise<void> {
    const browser = await initializeBrowser(browserState);
    try {
        const options = JSON.parse(call.request.getRawoptions());
        browserState.context = await _newBrowserContext(browser);
        callback(null, emptyWithLog(`Succesfully created context with options ${options}`));
    } catch (error) {
        callback(error, null);
        return;
    }
}

export async function createBrowser(
    call: ServerUnaryCall<Request.Browser>,
    callback: sendUnaryData<Response.Empty>,
    browsers: BrowserState[],
    setBrowser: (newBrowser: BrowserState) => void,
): Promise<void> {
    const browserType = call.request.getBrowser();
    const headless = call.request.getHeadless();

    try {
        const options = JSON.parse(call.request.getRawoptions());
        const [name, browser] = await _newBrowser(browserType, headless, options);
        const browserState = new BrowserState();
        browserState.name = name;
        browserState.browser = browser;
        if (browsers[0].browser) browsers.push(browserState);
        else browsers[0] = browserState;
        setBrowser(browserState);
        callback(null, emptyWithLog(`Succesfully created browser ${browserType} with options ${options}`));
    } catch (error) {
        callback(error, null);
    }
}

export async function autoActivatePages(
    call: ServerUnaryCall<Request.Empty>,
    callback: sendUnaryData<Response.Empty>,
    browserState: BrowserState,
) {
    exists(browserState?.context, callback, 'Tried to focus next opened page');

    browserState.context.on('page', (page) => {
        browserState.page = page;
        console.log('Changed active page');
    });
    callback(null, emptyWithLog('Will focus future ``pages`` in this context'));
}

async function _switchPage(index: number, browserState: BrowserState) {
    const context = browserState.context;
    if (!context) throw new Error('Tried to switch page, no open context');
    const pages = context.pages();

    if (pages[index]) {
        browserState.page = pages[index];
        return;
    } else {
        try {
            console.log('Started waiting for a page to pop up');
            const page = await context.waitForEvent('page', { timeout: 10000 });
            browserState.page = page;
            return;
        } catch (pwError) {
            console.log('Wait was not fulfilled');
            console.log(pwError);
            const mapped = pages?.map((p) => p.url()).join(',');
            const message = `No page for index ${index}. Open pages: ${mapped}`;
            const error = new Error(message);
            throw error;
        }
    }
}

async function _switchContext(index: number, browserState: BrowserState) {
    const contexts = browserState.browser?.contexts();
    if (contexts && contexts[index]) {
        browserState.context = contexts[index];
        return;
    } else {
        const mapped = contexts
            ?.map((c) => c.pages())
            .reduce((acc, val) => acc.concat(val), [])
            .map((p) => p.url());

        const message = `No context for index ${index}. Open contexts: ${mapped}`;
        const error = new Error(message);
        throw error;
    }
}

export async function switchPage(
    call: ServerUnaryCall<Request.Index>,
    callback: sendUnaryData<Response.Empty>,
    browserState: BrowserState,
) {
    console.log('Changing current active page');
    const index = call.request.getIndex();
    await _switchPage(index, browserState);
    callback(null, emptyWithLog('Succesfully changed active page'));
}

export async function switchContext(
    call: ServerUnaryCall<Request.Index>,
    callback: sendUnaryData<Response.Empty>,
    browserState: BrowserState,
): Promise<void> {
    exists(browserState.browser, callback, "Tried to switch active context but browser wasn't open");
    const index = call.request.getIndex();

    await _switchContext(index, browserState).catch((error) => callback(error, null));
    await _switchPage(0, browserState).catch(console.log);
    callback(null, emptyWithLog('Succesfully changed active context'));
}

export async function switchBrowser(
    call: ServerUnaryCall<Request.Index>,
    callback: sendUnaryData<Response.Empty>,
    browsers: BrowserState[],
    setBrowser: (newBrowser: BrowserState) => void,
): Promise<void> {
    const index = call.request.getIndex();
    const newState = browsers[index];
    if (newState) {
        setBrowser(newState);
    } else {
        const mapped = browsers.map((browserState) => browserState.name);
        const message = `No browser for index ${index}. Open browsers: ` + mapped;
        const error = new Error(message);
        callback(error, null);
    }
    try {
        // Try to switch to page and context in target browser
        await _switchContext(0, newState);
        await _switchPage(0, newState);
    } catch (pwError) {
        console.log(pwError);
    }

    callback(null, emptyWithLog('Succesfully changed active browser'));
}