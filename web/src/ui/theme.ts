/** Read the screen palette for canvas/WebGL consumers. CSS remains the source.
 * Read once when a view is constructed (the app currently has one static theme). */
export function visualTheme(element: Element) {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token('--bg'),
    text: token('--text'),
    textDim: token('--text-dim'),
    accent: token('--accent'),
    labelBackground: token('--bg-label'),
    font: token('--font'),
    plotPrimary: token('--plot-primary'),
    plotCursor: token('--plot-cursor'),
  };
}
