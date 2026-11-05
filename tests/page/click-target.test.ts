/** @jest-environment jsdom */
import { canClick } from '@/adapter/page/click-target';

const target = { x: 100, y: 100, width: 120, height: 40 };
const point = { x: 160, y: 120 };

function fixture(): { button: HTMLButtonElement; span: HTMLSpanElement } {
  document.body.innerHTML = '<button><span>Control</span></button>';
  const button = document.querySelector('button')!;
  const span = document.querySelector('span')!;
  button.getBoundingClientRect = () => ({ ...target, left: target.x, top: target.y, right: 220, bottom: 140, toJSON: () => ({}) });
  document.elementFromPoint = () => span;
  return { button, span };
}

test('accepts the live target through a nested label', () => {
  fixture();
  expect(canClick({ target, point })).toBe(true);
});

test('rejects a covering overlay instead of clicking through it', () => {
  fixture();
  const overlay = document.createElement('aside');
  document.body.append(overlay);
  document.elementFromPoint = () => overlay;
  expect(canClick({ target, point })).toBe(false);
});

test.each(['disabled', 'aria-disabled', 'inert'])('rejects a %s control', (attribute) => {
  const { button } = fixture();
  button.setAttribute(attribute, 'true');
  expect(canClick({ target, point })).toBe(false);
});

test('rejects a control whose rectangle changed during travel', () => {
  fixture();
  expect(canClick({ target: { ...target, x: 105 }, point })).toBe(false);
});

test.each([{ x: -1, y: 120 }, { x: NaN, y: 120 }, { x: 100, y: 120 }, { x: 220, y: 120 }])('rejects invalid or edge hit %j', (badPoint) => {
  fixture();
  expect(canClick({ target, point: badPoint })).toBe(false);
});
