// 自有合成源码。固定行列是 D5 浏览器验收合同，不随意插入行。
export function renderSourceMapScenario(): never {
  const label = "FI_D5_SYNTHETIC 中文😀";
  throw new TypeError(label);
}
export function runSourceMapScenario(): never {
  try {
    return renderSourceMapScenario();
  } finally {
    Math.random(); // 保留真实调用帧，避免 WebKit 尾调用消除。
  }
}
