#!/usr/bin/env node
// Checks which browsers the shell treats as phones (server/components/mobile.ts) with plain node,
// which strips the TypeScript types itself: phones get the "not available on mobile" notice;
// desktops at any window size and tablets never do. No browser, no server.
import assert from "node:assert/strict";
import { isOpenOnPhones, isPhone } from "../server/components/mobile.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log("PASS:", name);
}

const UA = {
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  ipod: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1",
  androidChromePhone: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  androidFirefoxPhone: "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
  androidSamsungPhone: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  windowsPhone: "Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15063",
  androidTablet: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  androidFirefoxTablet: "Mozilla/5.0 (Android 14; Tablet; rv:133.0) Gecko/133.0 Firefox/133.0",
  // iPadOS 13+ Safari asks for desktop sites by default and sends the Mac user agent.
  ipadDesktopClass: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  // An iPad set to ask for mobile sites, or an older one: "Mobile/…" but no "iPhone".
  ipadMobileClass: "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
};

check("desktop Chrome, Firefox, Safari and Edge are not phones", () => {
  for (const name of ["chromeWindows", "chromeMac", "chromeLinux", "firefoxWindows", "firefoxLinux", "safariMac", "edgeWindows"]) {
    assert.equal(isPhone({ userAgent: UA[name] }), false, name);
  }
});

check("desktop Chromium browsers reporting mobile: false are not phones", () => {
  for (const name of ["chromeWindows", "chromeMac", "edgeWindows"]) {
    assert.equal(isPhone({ userAgent: UA[name], userAgentData: { mobile: false } }), false, name);
  }
});

check("iPhone Safari, iPhone Chrome and an iPod touch are phones", () => {
  for (const name of ["iphoneSafari", "iphoneChrome", "ipod"]) {
    assert.equal(isPhone({ userAgent: UA[name] }), true, name);
  }
});

check("Android phones are phones, by user agent alone or with mobile: true", () => {
  for (const name of ["androidChromePhone", "androidFirefoxPhone", "androidSamsungPhone"]) {
    assert.equal(isPhone({ userAgent: UA[name] }), true, name);
  }
  assert.equal(isPhone({ userAgent: UA.androidChromePhone, userAgentData: { mobile: true } }), true);
});

check("a Windows Phone is a phone", () => {
  assert.equal(isPhone({ userAgent: UA.windowsPhone }), true);
});

check("Android tablets are not phones", () => {
  assert.equal(isPhone({ userAgent: UA.androidTablet }), false);
  assert.equal(isPhone({ userAgent: UA.androidTablet, userAgentData: { mobile: false } }), false);
  assert.equal(isPhone({ userAgent: UA.androidFirefoxTablet }), false);
});

check("iPads are not phones, desktop-class or not", () => {
  assert.equal(isPhone({ userAgent: UA.ipadDesktopClass }), false);
  assert.equal(isPhone({ userAgent: UA.ipadMobileClass }), false);
});

check("userAgentData.mobile wins over the user agent string, either way", () => {
  assert.equal(isPhone({ userAgent: UA.chromeWindows, userAgentData: { mobile: true } }), true);
  assert.equal(isPhone({ userAgent: UA.androidChromePhone, userAgentData: { mobile: false } }), false);
});

check("without a usable userAgentData.mobile the user agent string decides", () => {
  assert.equal(isPhone({ userAgent: UA.iphoneSafari, userAgentData: null }), true);
  assert.equal(isPhone({ userAgent: UA.iphoneSafari, userAgentData: {} }), true);
  assert.equal(isPhone({ userAgent: UA.chromeWindows, userAgentData: {} }), false);
});

check("no identity at all is not a phone", () => {
  assert.equal(isPhone({}), false);
  assert.equal(isPhone({ userAgent: "" }), false);
});

check("only /privacy stays open to phones", () => {
  assert.equal(isOpenOnPhones("/privacy"), true);
  assert.equal(isOpenOnPhones("/privacy/"), true);
  for (const path of ["/", "/me", "/auth/login", "/auth/password", "/auth/join", "/join/ABC123", "/plaza", "/privacy-x", "/x/privacy"]) {
    assert.equal(isOpenOnPhones(path), false, path);
  }
});

console.log(JSON.stringify({ result: "PASS", checks: passed }));
