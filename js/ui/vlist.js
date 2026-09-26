// Tiny virtualized list: renders only the visible rows of a (possibly long) list.

export class VList {
  /**
   * @param el scroll container (fixed height via CSS)
   * @param opts { rowHeight, renderRow(item, index) -> html string, overscan }
   */
  constructor(el, opts) {
    this.el = el;
    this.rowH = opts.rowHeight || 32;
    this.renderRow = opts.renderRow;
    this.overscan = opts.overscan || 12;
    this.items = [];
    this.inner = document.createElement('div');
    this.inner.className = 'vlist-inner';
    this.inner.style.position = 'relative';
    el.innerHTML = '';
    el.appendChild(this.inner);
    this.onScroll = () => this.paint();
    el.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.paint()) : null;
    if (this.ro) this.ro.observe(el);
    this.last = '';
  }

  setItems(items) {
    this.items = items;
    this.inner.style.height = `${items.length * this.rowH}px`;
    this.last = '';
    this.paint(true);
  }

  paint(force = false) {
    const h = this.el.clientHeight || 600;
    const top = this.el.scrollTop;
    const first = Math.max(0, Math.floor(top / this.rowH) - this.overscan);
    const last = Math.min(this.items.length, Math.ceil((top + h) / this.rowH) + this.overscan);
    const key = `${first}:${last}:${this.items.length}`;
    if (!force && key === this.last) return;
    this.last = key;
    let out = '';
    for (let i = first; i < last; i++) {
      out += `<div class="vrow" style="top:${i * this.rowH}px;height:${this.rowH}px" data-index="${i}">${this.renderRow(this.items[i], i)}</div>`;
    }
    this.inner.innerHTML = out;
  }

  scrollToIndex(i) {
    if (i < 0) return;
    const top = i * this.rowH;
    const h = this.el.clientHeight;
    if (top < this.el.scrollTop || top + this.rowH > this.el.scrollTop + h) {
      this.el.scrollTop = Math.max(0, top - h / 3);
    }
  }

  destroy() {
    this.el.removeEventListener('scroll', this.onScroll);
    if (this.ro) this.ro.disconnect();
  }
}
