'use strict';

// Compatibility fixes for the pinned foliate-js paginator. Applied when serving the module,
// so npm ci, Docker and read-only node_modules installations all get the same source.
// Upstream race report: https://github.com/johnfactotum/foliate-js/issues/149
function patchPaginator(input) {
  let source = input.replace(/\r\n/g, '\n');
  const replace = (before, after) => {
    const index = source.indexOf(before);
    if (index < 0 || source.indexOf(before, index + before.length) >= 0) throw new Error('The foliate-js paginator changed; review the Flyleaf navigation compatibility patch.');
    source = source.slice(0, index) + after + source.slice(index + before.length);
  };
  replace('    snap(vx, vy) {', `    snap(vx, vy) {
        // touchend fires for taps too. Never race an in-flight programmatic turn.
        if (this.#locked) return`);
  replace("        this.#scrollToPage(page, 'snap').then(() => {\n            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null\n            if (dir) return this.#goTo({\n                index: this.#adjacentIndex(dir),\n                anchor: dir < 0 ? () => 1 : () => 0,\n            })\n        })", `        return this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir && !this.#locked) return this.goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        }).catch(error => this.dispatchEvent(new CustomEvent('navigation-error', { detail: error })))`);
  replace(`    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }`, `    async goTo(target) {
        if (this.#locked) return
        this.#locked = true
        try {
            const resolved = await target
            if (this.#canGoToIndex(resolved.index)) return await this.#goTo(resolved)
        } finally {
            this.#locked = false
        }
    }`);
  replace(`        const prev = dir === -1
        const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
        if (shouldGo) await this.#goTo({
            index: this.#adjacentIndex(dir),
            anchor: prev ? () => 1 : () => 0,
        })
        if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        this.#locked = false`, `        try {
            const prev = dir === -1
            const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (shouldGo) {
                const index = this.#adjacentIndex(dir)
                if (this.#canGoToIndex(index)) await this.#goTo({
                    index, anchor: prev ? () => 1 : () => 0,
                })
            }
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } finally {
            this.#locked = false
        }`);
  replace('                    return {}\n                }))', '                    throw e\n                }))');
  replace('class View {\n', 'class View {\n    #cancelLoad\n');
  const start = source.indexOf('    async load(src, afterLoad, beforeRender) {');
  const end = source.indexOf('\n    render(layout) {', start);
  if (start < 0 || end < 0) throw new Error('Missing foliate-js View.load() patch target.');
  source = source.slice(0, start) + `    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(\`\${src} is not string\`)
        this.#cancelLoad?.()
        return new Promise((resolve, reject) => {
            const frame = this.#iframe
            let timer
            const cleanup = () => {
                clearTimeout(timer)
                frame.removeEventListener('load', loaded)
                frame.removeEventListener('error', failed)
                this.#cancelLoad = null
            }
            const fail = error => { cleanup(); reject(error) }
            const failed = () => fail(new Error('Ebook section failed to load'))
            const loaded = () => {
                try {
                    const doc = this.document
                    if (!doc?.body) throw new Error('Ebook section has no body')
                    afterLoad?.(doc)
                    frame.style.display = 'block'
                    const { vertical, rtl } = getDirection(doc)
                    const background = getBackground(doc)
                    this.#vertical = vertical
                    this.#rtl = rtl
                    this.#contentRange.selectNodeContents(doc.body)
                    const layout = beforeRender?.({ vertical, rtl, background })
                    this.render(layout)
                    this.#observer.observe(doc.body)
                    doc.fonts.ready.then(() => {
                        if (frame.isConnected && doc === this.document) this.expand()
                    }).catch(() => {})
                    cleanup()
                    resolve()
                } catch (error) { fail(error) }
            }
            this.#cancelLoad = () => fail(new Error('Ebook section load cancelled'))
            frame.addEventListener('load', loaded)
            frame.addEventListener('error', failed)
            // Reject the operation, rather than just unlocking a still-running navigation.
            timer = setTimeout(() => {
                frame.src = 'about:blank'
                fail(new Error('Ebook section load timed out'))
            }, 20000)
            frame.src = src
        })
    }
` + source.slice(end);
  replace(`    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }`, `    destroy() {
        this.#cancelLoad?.()
        this.#observer.disconnect()
    }`);
  // Queued resize/font callbacks can outlive their section or the reader itself.
  replace('    render() {\n        if (!this.#view) return', '    render() {\n        if (!this.#view?.document?.body) return');
  replace('    render(layout) {\n        if (!layout) return', '    render(layout) {\n        if (!this.#iframe.isConnected || !this.document?.body || !layout) return');
  replace('    #observer = new ResizeObserver(() => this.expand())', '    #observer = new ResizeObserver(() => {\n        if (this.#iframe.isConnected && this.document?.body) this.expand()\n    })');
  replace('this.#background.style.background = getBackground(this.#view.document))', 'this.#view?.document?.body && (this.#background.style.background = getBackground(this.#view.document)))');
  replace("this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())", "this.#view?.document?.fonts?.ready?.then(() => {\n            if (this.#view?.document?.body) this.#view.expand()\n        }).catch(() => {})");
  return source;
}
module.exports = { patchPaginator };
