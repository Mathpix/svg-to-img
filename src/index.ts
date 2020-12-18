import { Browser } from "puppeteer";
import * as chromium from "chrome-aws-lambda";
import * as puppeteer from "puppeteer";
import { getFileTypeFromPath, renderSvg, stringifyFunction, writeFileAsync } from "./helpers";
import { config, defaultOptions, defaultPngShorthandOptions, defaultJpegShorthandOptions, defaultWebpShorthandOptions } from "./constants";
import { IOptions, IShorthandOptions, IConnectOptions } from "./typings";

export class BrowserSource {
  private queue: Array<(result: Browser) => void> = [];
  private browserDestructionTimeout: NodeJS.Timeout | undefined;
  private browserInstance: Browser | undefined;
  private browserState: "closed" | "opening" | "open" = "closed";

  constructor (private readonly factory: () => Promise<Browser>) {}

  public async getBrowser (): Promise<Browser> {
    return new Promise(async (resolve: (result: Browser) => void, reject: (err: any) => void) => {
      /* istanbul ignore if */
      if (this.browserDestructionTimeout) {
        clearTimeout(this.browserDestructionTimeout);
      }

      /* istanbul ignore else */
      if (this.browserState === "closed") {
        // Browser is closed
        this.queue.push(resolve);
        this.browserState = "opening";
        try {
          this.browserInstance = await this.factory();
          this.browserState = "open";

          return this.executeQueuedRequests(this.browserInstance);
        } catch (error) {
          this.browserState = "closed";

          return reject(error);
        }
      }

      /* istanbul ignore next */
      if (this.browserState === "opening") {
        // Queue request and wait for the browser to open
        return this.queue.push(resolve);
      }

      /* istanbul ignore next */
      if (this.browserState === "open") {
        // Browser is already open
        if (this.browserInstance) {
          return resolve(this.browserInstance);
        }
      }
    });
  };

  public scheduleBrowserForDestruction () {
    /* istanbul ignore if */
    if (this.browserDestructionTimeout) {
      clearTimeout(this.browserDestructionTimeout);
    }
    this.browserDestructionTimeout = setTimeout(async () => {
      /* istanbul ignore next */
      if (this.browserInstance) {
        this.browserState = "closed";
        await this.browserInstance.close();
      }
    }, 500);
  };

  private executeQueuedRequests (browser: Browser) {
    for (const resolve of this.queue) {
      resolve(browser);
    }
    // Clear items from the queue
    this.queue.length = 0;
  };
};

export class Svg {

  constructor (private readonly svg: Buffer|string, private browserSource: BrowserSource) {}

  public async to (options: IOptions): Promise<Buffer|string> {
    return this.convertSvg(this.svg, options, this.browserSource);
  };

  public async toPng (options?: IShorthandOptions): Promise<Buffer|string> {
    return this.convertSvg(this.svg, {...defaultPngShorthandOptions, ...options}, this.browserSource);
  };

  public async toJpeg (options?: IShorthandOptions): Promise<Buffer|string> {
    return this.convertSvg(this.svg, {...defaultJpegShorthandOptions, ...options}, this.browserSource);
  };

  public async toWebp (options?: IShorthandOptions): Promise<Buffer|string> {
    return this.convertSvg(this.svg, {...defaultWebpShorthandOptions, ...options}, this.browserSource);
  };

  private async convertSvg (inputSvg: Buffer|string, passedOptions: IOptions, browserSource: BrowserSource): Promise<Buffer|string> {
    const svg = Buffer.isBuffer(inputSvg) ? (inputSvg as Buffer).toString("utf8") : inputSvg;
    const options = {...defaultOptions, ...passedOptions};
    const browser = await browserSource.getBrowser();
    const page = (await browser.pages())[0];

    // ⚠️ Offline mode is enabled to prevent any HTTP requests over the network
    await page.setOfflineMode(true);

    // Infer the file type from the file path if no type is provided
    if (!passedOptions.type && options.path) {
      const fileType = getFileTypeFromPath(options.path);

      if (config.supportedImageTypes.includes(fileType)) {
        options.type = fileType as IOptions["type"];
      }
    }

    const base64 = await page.evaluate(stringifyFunction(renderSvg, svg, {
      width: options.width,
      height: options.height,
      type: options.type,
      quality: options.quality,
      background: options.background,
      clip: options.clip,
      jpegBackground: config.jpegBackground
    }));

    browserSource.scheduleBrowserForDestruction();

    const buffer = Buffer.from(base64, "base64");

    if (options.path) {
      await writeFileAsync(options.path, buffer);
    }

    if (options.encoding === "base64") {
      return base64;
    }

    if (!options.encoding) {
      return buffer;
    }

    return buffer.toString(options.encoding);
  };
}

export class SvgToImg {
  constructor (private readonly browserSource: BrowserSource) {}
  public from (svg: Buffer|string) {
    return new Svg(svg, this.browserSource);
  };
}

const defaultBrowserSource = new BrowserSource(async () => {
  return process.env.IS_LOCAL && process.env.IS_LOCAL==="true"
    ?
      await puppeteer.launch(config.puppeteer)
    :
      await chromium.puppeteer.launch(
        {
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath,
          headless: chromium.headless,
          ignoreHTTPSErrors: true
        }
      )
});

export const from = (svg: Buffer|string) => {
  return new SvgToImg(defaultBrowserSource).from(svg);
}

/* istanbul ignore next */
export const connect = (options: IConnectOptions) => {
  return new SvgToImg(new BrowserSource(async () => {
    return process.env.IS_LOCAL && process.env.IS_LOCAL==="true"
      ?
        puppeteer.connect(options)
      :
      chromium.puppeteer.connect(options)
  }));
}

export { IOptions, IShorthandOptions, IConnectOptions };
