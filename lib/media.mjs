import { execFile } from "node:child_process";
import { chmod, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function dimensions(path) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    path,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  if (!Number.isSafeInteger(stream?.width) || !Number.isSafeInteger(stream?.height) ||
      stream.width < 1 || stream.height < 1) {
    throw new Error("widget screenshot dimensions are unavailable");
  }
  return { width: stream.width, height: stream.height };
}

export async function composeWidgetComparison(selectedPath, resultPath, outputPath, { gap = 24 } = {}) {
  const [selected, result] = await Promise.all([dimensions(selectedPath), dimensions(resultPath)]);
  const height = Math.max(selected.height, result.height);
  const temporary = `${outputPath}.partial-${process.pid}.webp`;
  const filter = [
    `[0:v]pad=${selected.width + gap}:${height}:0:${Math.floor((height - selected.height) / 2)}:white[left]`,
    `[1:v]pad=${result.width}:${height}:0:${Math.floor((height - result.height) / 2)}:white[right]`,
    "[left][right]hstack=inputs=2[comparison]",
  ].join(";");
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", selectedPath,
      "-i", resultPath,
      "-filter_complex", filter,
      "-map", "[comparison]",
      "-frames:v", "1",
      "-c:v", "libwebp",
      "-lossless", "1",
      "-compression_level", "6",
      "-y", temporary,
    ]);
    await chmod(temporary, 0o600);
    await rename(temporary, outputPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    selected,
    result,
    comparison: { width: selected.width + gap + result.width, height },
    gap,
    background: "white",
    left: "selected",
    right: "result",
  };
}
