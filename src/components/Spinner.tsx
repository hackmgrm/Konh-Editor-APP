/**
 * The one busy indicator.
 *
 * A button that says 长图 and then says 渲染中… is a button that changes width
 * mid-press, and a row of them shuffles sideways every time one starts working.
 * So the label never moves: the leading icon is swapped for this ring instead,
 * which occupies exactly the space a 14–15px Phosphor glyph does.
 */
export default function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
