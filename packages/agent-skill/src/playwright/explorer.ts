import { chromium, type Browser, type Page } from 'playwright';

export interface PersonaViewConfig {
  name: string; // e.g. "Executive / CEO", "VP Membership"
  route: string;
  expectedCardSelectors?: string[];
}

export interface VisualInspectionOptions {
  explorerUrl?: string;
  personas?: PersonaViewConfig[];
  routesToInspect?: string[];
  headless?: boolean;
  timeoutMs?: number;
}

export interface VisualInspectionResult {
  passed: boolean;
  inspectedRoutes: string[];
  graphQLErrors: string[];
  consoleErrors: string[];
  pageErrors: string[];
  infrastructureErrors: string[];
  kpiChecksPassed: boolean;
  durationMs: number;
}

/**
 * Automates browser inspection of MJExplorer dashboards, views, and persona layouts.
 * Checks for:
 * 1. Zero unhandled JavaScript errors (pageerror)
 * 2. Zero GraphQL network response errors
 * 3. Successful Angular bootstrapping and DOM stabilization
 * 4. Presence of rendered KPI dashboard cards without NaN/Error states
 */
export async function runVisualInspection(
  options: VisualInspectionOptions = {}
): Promise<VisualInspectionResult> {
  const explorerUrl = options.explorerUrl ?? 'http://localhost:4303';
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 15000;

  const routes: string[] = options.routesToInspect ?? [];
  if (options.personas) {
    for (const p of options.personas) {
      if (!routes.includes(p.route)) {
        routes.push(p.route);
      }
    }
  }
  if (routes.length === 0) {
    routes.push('/');
  }

  const startTime = Date.now();
  const graphQLErrors: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const infrastructureErrors: string[] = [];
  const inspectedRoutes: string[] = [];
  let kpiChecksPassed = true;

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless });
    const page: Page = await browser.newPage();

    // 1. Listen for unhandled runtime exceptions on page
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // 2. Listen for console error logs
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 3. Listen for GraphQL errors in response payloads
    page.on('response', async (res) => {
      if (res.url().includes('/graphql')) {
        try {
          const body = (await res.json()) as { errors?: Array<{ message: string }> };
          if (body?.errors && body.errors.length > 0) {
            for (const err of body.errors) {
              graphQLErrors.push(err.message);
            }
          }
        } catch {
          // Ignored non-JSON response
        }
      }
    });

    for (const route of routes) {
      const fullUrl = new URL(route, explorerUrl).toString();

      try {
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

        // Wait for Angular to boot and network idle
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000) }).catch(() => {});

        // Check for persona cards if configured
        const matchingPersona = options.personas?.find((p) => p.route === route);
        if (matchingPersona?.expectedCardSelectors) {
          for (const selector of matchingPersona.expectedCardSelectors) {
            const el = await page.$(selector);
            if (!el) {
              kpiChecksPassed = false;
              consoleErrors.push(`Persona '${matchingPersona.name}' missing expected card selector: ${selector}`);
            } else {
              const text = await el.innerText();
              if (text.includes('NaN') || text.toLowerCase().includes('error')) {
                kpiChecksPassed = false;
                consoleErrors.push(`Persona '${matchingPersona.name}' card '${selector}' contains invalid value: ${text}`);
              }
            }
          }
        }

        inspectedRoutes.push(route);
      } catch (navErr) {
        infrastructureErrors.push(
          `Failed navigating to '${fullUrl}': ${navErr instanceof Error ? navErr.message : String(navErr)}`
        );
      }
    }
  } catch (err) {
    infrastructureErrors.push(
      `Browser launch or automation error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  const passed =
    graphQLErrors.length === 0 &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    infrastructureErrors.length === 0 &&
    kpiChecksPassed;

  return {
    passed,
    inspectedRoutes,
    graphQLErrors,
    consoleErrors,
    pageErrors,
    infrastructureErrors,
    kpiChecksPassed,
    durationMs: Date.now() - startTime,
  };
}
