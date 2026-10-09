import { TabPlacement } from '@/adapter/tab-placement';

test('conceal/reveal reorder the tab below the dashboard and preserve the veil', () => {
  const dash = {};
  const veil = {};
  const tab = { setVisible: jest.fn() };
  const children: unknown[] = [dash];
  const host = { contentView: { children, addChildView: (view: unknown, index?: number): void => {
    const old = children.indexOf(view);
    if (old >= 0) children.splice(old, 1);
    children.splice(index ?? children.length, 0, view);
  } } };
  const placement = new TabPlacement(tab as never);
  placement.attach(host as never);
  children.push(veil);
  placement.hide();
  expect(children).toEqual([tab, dash, veil]);
  placement.hide();
  expect(children).toEqual([tab, dash, veil]);
  placement.show();
  expect(children).toEqual([dash, tab, veil]);
  expect(tab.setVisible).not.toHaveBeenCalledWith(false);
  placement.dispose();
  placement.hide();
  expect(children).toEqual([dash, tab, veil]);
});
