/**
 * perfect-tweet Puppeteer 渲染 pipeline
 * 加载 HTML → 等待字体/图片就绪 → 按倍率高清截图导出 PNG。
 * deviceScaleFactor 对应原版 html2canvas 的 scale（默认 3x）。
 *
 * 使用 puppeteer-core：npm install 不下载 Chromium（170MB，国内网络易卡死），
 * 渲染直接复用系统已装的 Chrome / Edge / Chromium（见 executableCandidates）。
 */

import path from 'node:path';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
];

/**
 * 返回可尝试的 Chrome / Chromium 路径（按优先级、自动去重）。
 * 不再用文件大小猜测浏览器是否完整：macOS 与 Chrome for Testing 的 launcher
 * 可能很小，真实可用性应以 puppeteer.launch() 的结果为准。
 */
function executableCandidates() {
    const candidates = [];
    const add = (candidate) => {
        if (candidate && fs.existsSync(candidate) && !candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
        if (!fs.existsSync(envPath)) {
            console.error(`⚠️  PUPPETEER_EXECUTABLE_PATH 指向的文件不存在：${envPath}`);
        }
        add(envPath);
    }

    // puppeteer-core 无 executablePath()；若环境里装了完整版 puppeteer（传递依赖）则优先用其自带浏览器
    if (typeof puppeteer.executablePath === 'function') {
        try { add(puppeteer.executablePath()); } catch { /* 浏览器尚未下载或不可用 */ }
    }

    const home = process.env.HOME || process.env.USERPROFILE || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const systemPaths = [
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        // Linux
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        // Windows
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(home, 'AppData', 'Local', 'Chromium', 'Application', 'chrome.exe'),
    ];
    systemPaths.forEach(add);
    return candidates;
}

function browserNotFoundError(attempts = []) {
    const details = attempts.length
        ? '\n已尝试：\n' + attempts.map(({ executablePath, error }) => `  - ${executablePath}: ${error}`).join('\n')
        : '';
    return new Error(
        '未找到可启动的 Chrome/Chromium。本 Skill 不随包下载浏览器，请任选其一：\n' +
        '  1) 安装系统 Google Chrome / Edge / Chromium（绝大多数电脑已自带）\n' +
        '  2) 设置 PUPPETEER_EXECUTABLE_PATH 指向浏览器可执行文件' + details
    );
}

/** 等待页面内所有图片与字体加载完成（头像、蓝标、背景图均为内联/base64 或远程 URL） */
async function waitAssets(page) {
    await page.evaluate(async () => {
        const imgs = Array.from(document.images);
        await Promise.all(imgs.map(img => img.complete ? Promise.resolve() :
            new Promise(resolve => { img.onload = img.onerror = resolve; })));
        if (document.fonts?.ready) await document.fonts.ready;
    });
    // 双保险：网络空闲（base64 大图解码 + 远程头像）
    await new Promise(r => setTimeout(r, 120));
}

/**
 * 渲染单张卡片 HTML 并截图。
 * @param {import('puppeteer').Browser} browser
 * @param {string} html renderCardHTML 输出的完整 HTML
 * @param {string} outPath 输出 PNG 路径
 * @param {number} scale 导出倍率（deviceScaleFactor）
 */
export async function screenshotCard(browser, html, outPath, scale = 3) {
    const page = await browser.newPage();
    try {
        // viewport 只需容纳卡片；倍率由 deviceScaleFactor 控制
        await page.setViewport({ width: 1400, height: 1600, deviceScaleFactor: scale });
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
        await waitAssets(page);

        const card = await page.$('#card');
        if (!card) throw new Error('页面中未找到 #card 元素');

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await card.screenshot({ path: outPath, omitBackground: true });
        return outPath;
    } finally {
        await page.close();
    }
}

/**
 * 启动 Puppeteer 浏览器（按候选顺序尝试，全部失败时给出可操作的报错）。
 * @returns {Promise<import('puppeteer').Browser>}
 */
export async function launchBrowser() {
    const candidates = executableCandidates();
    const attempts = [];

    for (const executablePath of candidates) {
        try {
            return await puppeteer.launch({
                headless: true,
                executablePath,
                args: LAUNCH_ARGS,
            });
        } catch (error) {
            attempts.push({ executablePath, error: error?.message || String(error) });
        }
    }

    throw browserNotFoundError(attempts);
}

/**
 * 批量渲染：一个 Browser 实例依次渲染多张卡片（稳定且省资源）。
 * @param {Array<{html: string, outPath: string}>} jobs
 * @param {number} scale
 * @returns {Promise<Array<string>>} 成功输出的文件路径列表
 */
export async function screenshotBatch(jobs, scale = 3) {
    const browser = await launchBrowser();
    try {
        const done = [];
        for (const job of jobs) {
            const out = await screenshotCard(browser, job.html, job.outPath, scale);
            done.push(out);
        }
        return done;
    } finally {
        await browser.close();
    }
}
