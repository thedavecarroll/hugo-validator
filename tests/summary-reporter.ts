import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeStatus, PROGRESS_PREFIX } from './helpers';

interface TestSummary {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  rawStatus: string; // Playwright's own status: passed, failed, timedOut, skipped, interrupted
  duration: string;
  output: string[];
  errors: string[];
  warnings: string[];
}

interface SuiteSummary {
  suite: string;
  tests: TestSummary[];
}

interface ReportSummary {
  timestamp: string;
  duration: string;
  passed: number;
  failed: number;
  skipped: number;
  suites: SuiteSummary[];
}

class SummaryReporter implements Reporter {
  // suite title -> test id -> summary. Keyed by id so a retry replaces the
  // earlier attempt instead of being listed twice.
  private suiteMap: Map<string, Map<string, TestSummary>> = new Map();
  private startTime: number = 0;
  private outputDir: string = './test-results';
  private totalTests: number = 0;
  private finishedTests: number = 0;

  // This reporter writes live progress itself, so Playwright adds no other console reporter
  printsToStdio() {
    return true;
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.startTime = Date.now();
    this.outputDir = config.projects[0].outputDir;
    this.totalTests = suite.allTests().length;
    console.log(`   ${this.totalTests} tests on ${config.workers} parallel workers`);
  }

  // Show test output as it happens, so a long run is visibly alive
  onStdOut(chunk: string | Buffer, test?: TestCase) {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.log(`   ${line.trim()}`);
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const suiteName = test.parent.title;

    if (!this.suiteMap.has(suiteName)) {
      this.suiteMap.set(suiteName, new Map());
    }

    const output: string[] = [];
    for (const entry of result.stdout) {
      const text = typeof entry === 'string' ? entry : Buffer.isBuffer(entry) ? entry.toString() : '';
      output.push(...text.split('\n').map(line => line.trim()));
    }

    const errors: string[] = [];
    for (const error of result.errors) {
      if (error.message) {
        // Strip terminal colour codes so reports stay readable
        errors.push(error.message.replace(/\u001b\[[0-9;]*m/g, '').trim());
      }
    }

    const status = normalizeStatus(result.status);

    // A retried test reports again: count it once
    if (!this.suiteMap.get(suiteName)!.has(test.id)) this.finishedTests++;
    const mark = status === 'passed' ? '✓' : status === 'failed' ? '✗' : '-';
    console.log(`   ${mark} [${this.finishedTests}/${this.totalTests}] ${suiteName} › ${test.title} (${(result.duration / 1000).toFixed(1)}s)`);

    if (status === 'failed' && errors.length === 0) {
      errors.push(
        result.status === 'timedOut'
          ? `Test timed out after ${(result.duration / 1000).toFixed(0)}s`
          : `Test ended with status '${result.status}'`
      );
    }

    const warnings = test.annotations
      .filter(annotation => annotation.type === 'warning' && annotation.description)
      .map(annotation => annotation.description as string);

    this.suiteMap.get(suiteName)!.set(test.id, {
      name: test.title,
      status,
      rawStatus: result.status,
      duration: `${(result.duration / 1000).toFixed(2)}s`,
      // Progress lines are only useful live
      output: output.filter(o => o.length > 0 && !o.startsWith(PROGRESS_PREFIX)),
      errors,
      warnings,
    });
  }

  onEnd(result: FullResult) {
    const totalDuration = Date.now() - this.startTime;
    const suites: SuiteSummary[] = Array.from(this.suiteMap.entries()).map(([suite, tests]) => ({
      suite,
      tests: Array.from(tests.values()),
    }));

    let passed = 0, failed = 0, skipped = 0;
    for (const suite of suites) {
      for (const test of suite.tests) {
        if (test.status === 'passed') passed++;
        else if (test.status === 'failed') failed++;
        else skipped++;
      }
    }

    const summary: ReportSummary = {
      timestamp: new Date().toISOString(),
      duration: `${(totalDuration / 1000).toFixed(2)}s`,
      passed,
      failed,
      skipped,
      suites,
    };

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(this.outputDir, 'results.json'),
      JSON.stringify(summary, null, 2)
    );
  }
}

export default SummaryReporter;
