const DEFAULT_DEVICE_WIDTH = 1440;
const DEFAULT_DEVICE_HEIGHT = 1000;
const MIN_INNER_WIDTH = 1000;
const MIN_INNER_HEIGHT = 560;
const NARROW_MEDIA_QUERY = "(max-width: 700px)";
const LAYOUT_SETTLE_TOLERANCE_PX = 2;

export class UiRunnerPreconditionError extends Error {
  constructor(message, evidence) {
    super(`[UI_PRECONDITION] ${message}: ${JSON.stringify(evidence)}`);
    this.name = "UiRunnerPreconditionError";
  }
}

export async function normalizeDesktopViewport({ cdp, evaluateJson }) {
  const simulatedInitial = initialViewportFromEnvironment();
  const target = {
    deviceWidth: positiveInteger(process.env.NTFY_UI_VIEWPORT_WIDTH, DEFAULT_DEVICE_WIDTH),
    deviceHeight: positiveInteger(process.env.NTFY_UI_VIEWPORT_HEIGHT, DEFAULT_DEVICE_HEIGHT),
    minInnerWidth: MIN_INNER_WIDTH,
    minInnerHeight: MIN_INNER_HEIGHT,
  };
  try {
    if (simulatedInitial) {
      await setViewportOverride(cdp, simulatedInitial.deviceWidth, simulatedInitial.deviceHeight);
    }
    const before = await waitForStableViewport(evaluateJson);
    if (!before) {
      throw new UiRunnerPreconditionError("initial viewport did not stabilize", {
        simulatedInitial,
      });
    }
    await cdp("Emulation.clearDeviceMetricsOverride", {});
    await setViewportOverride(cdp, target.deviceWidth, target.deviceHeight);
    const normalized = await waitForStableViewport(evaluateJson, target);
    if (!normalized) {
      const observed = await readViewportMetrics(evaluateJson);
      throw new UiRunnerPreconditionError("desktop viewport could not be normalized", {
        before,
        target,
        observed,
      });
    }
    return { before, simulatedInitial, target, normalized };
  } catch (error) {
    await cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => undefined);
    throw error;
  }
}

function initialViewportFromEnvironment() {
  const width = process.env.NTFY_UI_INITIAL_VIEWPORT_WIDTH;
  const height = process.env.NTFY_UI_INITIAL_VIEWPORT_HEIGHT;
  if (width === undefined && height === undefined) return undefined;
  if (width === undefined || height === undefined) {
    throw new UiRunnerPreconditionError(
      "initial viewport width and height must be provided together",
      { width, height },
    );
  }
  return {
    deviceWidth: positiveInteger(width, DEFAULT_DEVICE_WIDTH),
    deviceHeight: positiveInteger(height, DEFAULT_DEVICE_HEIGHT),
  };
}

function setViewportOverride(cdp, width, height) {
  return cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false,
  });
}

export async function restoreViewport({ cdp, evaluateJson }, evidence) {
  await cdp("Emulation.clearDeviceMetricsOverride", {});
  const observed = await waitForStableViewport(evaluateJson);
  if (!observed) return { cleared: false, matchesBefore: false, observed };
  return {
    cleared: true,
    matchesBefore: Boolean(
      evidence?.before &&
        observed.innerWidth === evidence.before.innerWidth &&
        observed.innerHeight === evidence.before.innerHeight &&
        observed.narrow === evidence.before.narrow,
    ),
    observed,
  };
}

export async function waitForStableLayout(evaluateJson, selector, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const current = await evaluateJson(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const rect = element?.getBoundingClientRect();
        return JSON.stringify({
          found: Boolean(element),
          fonts: document.fonts?.status ?? "loaded",
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
          narrow: matchMedia(${JSON.stringify(NARROW_MEDIA_QUERY)}).matches
        });
      })()
    `);
    if (
      current.found &&
      current.fonts === "loaded" &&
      !current.narrow &&
      previous &&
      approximatelyEqual(current.width, previous.width) &&
      approximatelyEqual(current.height, previous.height)
    ) {
      stableSamples += 1;
      if (stableSamples >= 2) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
    await delay(100);
  }
  throw new UiRunnerPreconditionError("layout did not settle in desktop mode", {
    selector,
    observed: previous,
  });
}

async function waitForStableViewport(evaluateJson, target) {
  let previous;
  let stableSamples = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    const current = await readViewportMetrics(evaluateJson);
    const meetsTarget = target
      ? current.innerWidth >= target.minInnerWidth &&
        current.innerHeight >= target.minInnerHeight &&
        !current.narrow &&
        current.rootFontPx > 0
      : current.rootFontPx > 0;
    if (
      meetsTarget &&
      previous &&
      current.innerWidth === previous.innerWidth &&
      current.innerHeight === previous.innerHeight &&
      current.devicePixelRatio === previous.devicePixelRatio &&
      current.narrow === previous.narrow
    ) {
      stableSamples += 1;
      if (stableSamples >= 2) return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }
  return undefined;
}

function readViewportMetrics(evaluateJson) {
  return evaluateJson(`
    JSON.stringify({
      innerWidth,
      innerHeight,
      devicePixelRatio,
      rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      narrow: matchMedia(${JSON.stringify(NARROW_MEDIA_QUERY)}).matches
    })
  `);
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UiRunnerPreconditionError("viewport environment variable must be positive", {
      value,
    });
  }
  return parsed;
}

function approximatelyEqual(first, second) {
  return Math.abs(first - second) <= LAYOUT_SETTLE_TOLERANCE_PX;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
