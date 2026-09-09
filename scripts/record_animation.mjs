import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

async function main() {
  const outputDir = '/storage/export_temp';
  const finalDir = '/storage/exports';
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(finalDir, { recursive: true });

  console.log('Launching Chromium...');
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  // --- 1. Full Page / Card Animation (1440x900) ---
  console.log('Recording Full View...');
  const ctxFull = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: outputDir,
      size: { width: 1440, height: 900 }
    }
  });

  const pageFull = await ctxFull.newPage();
  await pageFull.goto('http://pages/pages/p12_2.html', { waitUntil: 'networkidle' });
  await pageFull.waitForFunction(() => window.Shell && document.querySelector('.sh-stage'));
  
  // Custom styling tweaks for video presentation: clean fonts & remove focus rings
  await pageFull.addStyleTag({
    content: `
      body { background: #f0f3f8 !important; }
      .sh-wrap { margin-top: 10px !important; }
      * { outline: none !important; }
    `
  });

  // Reset to initial state
  await pageFull.evaluate(() => window.Shell.go(0, true));
  await pageFull.waitForTimeout(1500);

  // Step 1: Initial setup
  console.log('Step 1: Given charges...');
  await pageFull.evaluate(() => window.Shell.go(1, false));
  await pageFull.waitForTimeout(3000);

  // Step 2: Test point P and vectors E1, E2
  console.log('Step 2: Test point P & field vectors...');
  await pageFull.evaluate(() => window.Shell.go(2, false));
  await pageFull.waitForTimeout(3500);

  // Step 3: Equation E1 = E2
  console.log('Step 3: Equation setup...');
  await pageFull.evaluate(() => window.Shell.go(3, false));
  await pageFull.waitForTimeout(3500);

  // Step 4: Neutral point calculation & answer
  console.log('Step 4: Neutral point calculated...');
  await pageFull.evaluate(() => window.Shell.go(4, false));
  await pageFull.waitForTimeout(3500);

  // Step 5: Electric field lines curving away
  console.log('Step 5: Electric field lines...');
  await pageFull.evaluate(() => window.Shell.go(5, false));
  await pageFull.waitForTimeout(4500);

  // Hold final answer and diagram
  await pageFull.waitForTimeout(3000);

  await pageFull.close();
  await ctxFull.close();

  const fullVideoFile = fs.readdirSync(outputDir).find(f => f.endsWith('.webm'));
  const fullWebmPath = path.join(outputDir, fullVideoFile);
  const fullMp4Path = path.join(finalDir, 'electric_field_neutral_point_full.mp4');

  console.log(`Converting ${fullWebmPath} to MP4...`);
  execSync(`ffmpeg -y -i "${fullWebmPath}" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p "${fullMp4Path}"`);
  console.log(`Saved: ${fullMp4Path}`);

  // Clean up temp webm
  fs.unlinkSync(fullWebmPath);

  // --- 2. Canvas-Focused Animation (1280x720) ---
  console.log('Recording Canvas-Only View...');
  const ctxCanvas = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: outputDir,
      size: { width: 1280, height: 720 }
    }
  });

  const pageCanvas = await ctxCanvas.newPage();
  await pageCanvas.goto('http://pages/pages/p12_2.html', { waitUntil: 'networkidle' });
  await pageCanvas.waitForFunction(() => window.Shell && document.querySelector('.sh-stage'));

  // Style to isolate the canvas diagram in full glory with clean background and title
  await pageCanvas.addStyleTag({
    content: `
      body {
        margin: 0 !important;
        padding: 0 !important;
        background: #ffffff !important;
        display: flex !important;
        justify-content: center !important;
        align-items: center !important;
        min-height: 100vh !important;
        overflow: hidden !important;
      }
      .sh-wrap {
        max-width: 1200px !important;
        width: 100% !important;
        margin: 0 auto !important;
      }
      .sh-head {
        border: none !important;
        box-shadow: none !important;
        background: transparent !important;
        text-align: center !important;
        padding: 10px 0 0 0 !important;
      }
      .sh-head h1 {
        font-size: 26px !important;
        color: #1e293b !important;
      }
      .sh-head .sh-problem { display: none !important; }
      .sh-main {
        display: flex !important;
        justify-content: center !important;
      }
      .sh-stage {
        border: 1px solid #e2e8f0 !important;
        box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05) !important;
        border-radius: 12px !important;
        background: #fafafa !important;
        width: 1100px !important;
        max-height: none !important;
        padding: 16px !important;
      }
      .sh-stage svg.sh-diagram {
        width: 100% !important;
        height: auto !important;
        max-height: none !important;
      }
      .sh-steps, .sh-bar, .sh-answer { display: none !important; }
    `
  });

  // Step through on canvas view
  await pageCanvas.evaluate(() => window.Shell.go(0, true));
  await pageCanvas.waitForTimeout(1500);

  await pageCanvas.evaluate(() => window.Shell.go(1, false));
  await pageCanvas.waitForTimeout(2500);

  await pageCanvas.evaluate(() => window.Shell.go(2, false));
  await pageCanvas.waitForTimeout(3000);

  await pageCanvas.evaluate(() => window.Shell.go(3, false));
  await pageCanvas.waitForTimeout(2500);

  await pageCanvas.evaluate(() => window.Shell.go(4, false));
  await pageCanvas.waitForTimeout(3000);

  await pageCanvas.evaluate(() => window.Shell.go(5, false));
  await pageCanvas.waitForTimeout(5000);

  await pageCanvas.waitForTimeout(2000);

  await pageCanvas.close();
  await ctxCanvas.close();
  await browser.close();

  const canvasVideoFile = fs.readdirSync(outputDir).find(f => f.endsWith('.webm'));
  const canvasWebmPath = path.join(outputDir, canvasVideoFile);
  const canvasMp4Path = path.join(finalDir, 'electric_field_neutral_point_canvas.mp4');

  console.log(`Converting ${canvasWebmPath} to MP4...`);
  execSync(`ffmpeg -y -i "${canvasWebmPath}" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p "${canvasMp4Path}"`);
  console.log(`Saved: ${canvasMp4Path}`);

  fs.unlinkSync(canvasWebmPath);
  fs.rmdirSync(outputDir);

  console.log('All exports completed successfully!');
}

main().catch(err => {
  console.error('Error recording animation:', err);
  process.exit(1);
});
