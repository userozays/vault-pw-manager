import { animate, stagger } from "motion";

// Hareketi azalt tercihine saygı: süreleri sıfırlar, son kareye atlar.
export const reduced = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Target = Element | Iterable<Element> | ArrayLike<Element>;

export function move(el: Target, keyframes: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const list = el instanceof Element ? [el] : Array.from(el);
  if (!list.length) return Promise.resolve();
  const opts = reduced() ? { ...options, duration: 0, delay: 0, type: "tween" } : options;
  const anim = animate(list as Element[], keyframes as never, opts as never);
  // Pencere görünmezken tarayıcı animasyonları duraklatabilir; akış takılmasın diye süre sınırı.
  const d = typeof opts.duration === "number" ? opts.duration : 0.8;
  const delay = typeof opts.delay === "number" ? opts.delay : 0;
  const limit = (d + delay) * 1000 + 500;
  return Promise.race([
    anim.finished,
    new Promise<void>((res) =>
      setTimeout(() => {
        anim.complete?.();
        res();
      }, limit),
    ),
  ]);
}

export const spring = (bounce = 0.22, duration = 0.55) => ({ type: "spring", bounce, duration });
export { stagger };

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789#$%&*+=?";

/** Metni rastgele karakterlerden soldan sağa "çözerek" yazar. */
export function decode(el: HTMLElement, text: string, ms = 520): Promise<void> {
  if (reduced() || !text) {
    el.textContent = text;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const fixed = Math.floor(p * text.length);
      let out = text.slice(0, fixed);
      for (let i = fixed; i < text.length; i++) out += text[i] === " " ? " " : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      el.textContent = out;
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

export function shake(el: Element) {
  return move(el, { x: [0, -14, 12, -9, 7, -4, 0] }, { duration: 0.48, ease: "easeOut" });
}
