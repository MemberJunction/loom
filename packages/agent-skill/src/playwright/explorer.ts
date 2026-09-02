import { chromium, type Browser, type Page } from 'playwright';

export interface VisualInspectionOptions {
  explorerUrl?: string;
  routesToInspect?: string[];
  headless?: boolean;
  timeoutMs?: number;
}

export interface VisualInspectionResult {
  passed: boolean;
  inspectedRoutes: string[];
  graphQLErrors: string[];
  consoleErrors: string[];
  durationMs: number;
}

/**
 * Automates browser inspection of MJExplorer dashboards and views
 * to verify visual and runtime invariants.
 */
export async function runVisualInspection(
  options: VisualInspectionOptions = {}
): Promise<VisualInspectionResult> {
  const explorerUrl = options.explorerUrl ?? 'http://localhost:4303';
  const routes = options.routesToInspect ?? ['/'];
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 15000;

  const startTime = Date.now();
  const graphQLErrors: string[] = [];
  const consoleErrors: string[] = [];
  const inspectedRoutes: string[] = [];

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless });
    const page: Page = await browser.newPage();

    // Listen for uncaught console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Listen for GraphQL responses with errors
    page.on('response', async (res) => {
      if (res.url().includes('/graphql')) {
        try {
          const body = await res.json() as { errors?: Array<{ message: string }> };
          if (body?.errors && body.errors.length > 0) {
            for (const err of body.errors) {
              graphQLErrors.push(err.message);
            }
          }
        } catch {
          // Non-JSON response ignored
        }
      }
    });

    for (const route of routes) {
      const fullUrl = new URL(route, explorerUrl).toString();
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      inspectedRoutes.push(route);
    }
  } catch (err) {
    consoleErrors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  const passed = graphQLErrors.length === 0 && consoleErrors.length === 0;

  return {
    passed,
    inspectedRoutes,
    graphQLErrors,
    consoleErrors,
    durationMs: Date.now() - startTime,
  };
}
