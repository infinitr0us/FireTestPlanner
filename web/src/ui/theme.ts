/** Read the screen palette for canvas/WebGL consumers. CSS remains the source.
 * Tokens live on :root, so consumers can be constructed before DOM attachment.
 * Consumers keep snapshots; the app currently has one static theme. */
export function visualTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token('--bg'),
    text: token('--text'),
    textDim: token('--text-dim'),
    accent: token('--accent'),
    labelBackground: token('--bg-label'),
    font: token('--font'),
    plotPrimary: token('--plot-primary'),
    plotSecondary: token('--plot-secondary'),
    plotGrid: token('--plot-grid'),
    plotCursor: token('--plot-cursor'),
  };
}
