/* @ds-bundle: {"format":4,"namespace":"Workbus","components":[{"name":"Button"},{"name":"Kbd"},{"name":"Input"},{"name":"Avatar"},{"name":"SeatState"},{"name":"Kind"},{"name":"Label"},{"name":"HeldPill"},{"name":"TaskState"},{"name":"Tabs"},{"name":"SidebarItem"},{"name":"Menu"},{"name":"CommandPalette"},{"name":"Toast"},{"name":"NewEventsPill"},{"name":"IssueRow"},{"name":"BoardCard"},{"name":"Message"},{"name":"ToolCall"},{"name":"ApprovalCard"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  function cx() { return Array.prototype.slice.call(arguments).filter(Boolean).join(' '); }

  // Lucide-style glyphs at 24 units, 1.5 stroke (the app uses lucide-react; these keep the bundle self-contained).
  var PATHS = {
    search: ['M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z', 'M20 20l-4-4'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'],
    pause: ['M6 5h4v14H6z', 'M14 5h4v14h-4z'],
    user: ['M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M4 21c1-4 4.5-6 8-6s7 2 8 6'],
    task: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'],
    doc: ['M6 3h9l4 4v14H6z', 'M9 12h7', 'M9 16h5'],
    message: ['M4 5h16v11H9l-5 4z'],
    plus: ['M12 5v14', 'M5 12h14']
  };
  function Icon(props) {
    var d = PATHS[props.name] || [];
    return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: props.strokeWidth || 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      d.map(function (p, i) { return h('path', { key: i, d: p }); }));
  }

  function Kbd(props) { return h('kbd', { className: 'wb-kbd' }, props.children); }

  function Button(props) {
    var variant = props.variant || 'secondary', size = props.size || 'md';
    return h('button', { type: props.type || 'button', className: cx('wb-btn', 'wb-btn--' + variant, size !== 'md' && 'wb-btn--' + size, props.className), onClick: props.onClick, disabled: props.disabled, title: props.title },
      props.icon ? h(Icon, { name: props.icon }) : null, props.children, props.kbd ? h(Kbd, null, props.kbd) : null);
  }

  function Input(props) {
    var input = h('span', { className: cx('wb-input', props.error && 'wb-input--error') },
      props.prefix ? h('span', { className: 'wb-input__affix' }, props.prefix) : null,
      h('input', { id: props.id, value: props.value, defaultValue: props.defaultValue, placeholder: props.placeholder, onChange: props.onChange, 'aria-invalid': props.error ? true : undefined }),
      props.kbd ? h(Kbd, null, props.kbd) : null);
    if (!props.label && !props.error && !props.hint) return input;
    return h('label', { className: 'wb-field', htmlFor: props.id },
      props.label ? h('span', { className: 'wb-field__label' }, props.label) : null, input,
      props.error ? h('span', { className: 'wb-field__error' }, props.error) : props.hint ? h('span', null, props.hint) : null);
  }

  function Avatar(props) {
    var size = props.size || 'sm';
    return h('span', { className: cx('wb-av', props.kind === 'agent' && 'wb-av--agent', size !== 'sm' && 'wb-av--' + size), title: props.name, 'aria-label': props.name ? props.name + (props.kind === 'agent' ? ' (agent)' : '') : undefined }, props.initials);
  }

  var STATE_LABEL = { active: 'active', working: 'working', waiting: 'waiting', paused: 'paused', over_budget: 'over budget' };
  function SeatState(props) {
    var s = props.state || 'active';
    return h('span', { className: cx('wb-state', 'wb-state--' + s) }, h('i'), props.label || STATE_LABEL[s]);
  }

  var KIND_TONE = { approval: 'held', decision: 'held', budget: 'budget', review: 'review', proposal: 'review', mention: 'mention', done: 'done', failed: 'failed' };
  function Kind(props) {
    var k = props.kind || 'mention';
    return h('span', { className: cx('wb-kind', 'wb-kind--' + (KIND_TONE[k] || 'mention')) }, props.children || k);
  }

  function Label(props) { return h('span', { className: 'wb-label' }, props.name, props.value != null ? '=' : null, props.value != null ? h('b', null, props.value) : null); }

  function HeldPill(props) { return h('span', { className: 'wb-held' }, h('i'), 'Held · ', props.kind || 'approval'); }

  function TaskState(props) {
    var s = props.state || 'ready';
    var title = { ready: 'Ready', claimed: 'Claimed', held: 'Held for you', done: 'Done', failed: 'Failed' }[s];
    var kids;
    if (s === 'ready') kids = [h('circle', { key: 1, cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'var(--muted)', strokeWidth: 1.5 })];
    else if (s === 'claimed') kids = [h('circle', { key: 1, cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'var(--agent)', strokeWidth: 1.5 }), h('path', { key: 2, d: 'M8 4.5a3.5 3.5 0 0 1 0 7z', fill: 'var(--agent)' })];
    else if (s === 'held') kids = [h('circle', { key: 1, cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'var(--held)', strokeWidth: 1.5 }), h('path', { key: 2, d: 'M6.5 6v4M9.5 6v4', stroke: 'var(--held)', strokeWidth: 1.5 })];
    else if (s === 'done') kids = [h('circle', { key: 1, cx: 8, cy: 8, r: 6.25, fill: 'var(--success)' }), h('path', { key: 2, d: 'M5.5 8.2l1.7 1.7 3.3-3.4', fill: 'none', stroke: 'var(--bg)', strokeWidth: 1.5 })];
    else kids = [h('circle', { key: 1, cx: 8, cy: 8, r: 6.25, fill: 'var(--danger)' }), h('path', { key: 2, d: 'M6 6l4 4M10 6l-4 4', stroke: 'var(--bg)', strokeWidth: 1.5 })];
    return h('svg', { className: 'wb-task', viewBox: '0 0 16 16', role: 'img', 'aria-label': title }, h('title', null, title), kids);
  }

  function Tabs(props) {
    var st = React.useState(props.value || (props.tabs[0] && props.tabs[0].id)), cur = st[0], set = st[1];
    return h('div', { className: 'wb-tabs', role: 'tablist' }, props.tabs.map(function (t) {
      if (t.add) return h('button', { key: t.id, className: 'wb-tab wb-tab--add', type: 'button', onClick: t.onAdd }, '+ ', t.label);
      return h('button', { key: t.id, className: 'wb-tab', role: 'tab', type: 'button', 'aria-selected': cur === t.id, onClick: function () { set(t.id); props.onChange && props.onChange(t.id); } },
        t.label, t.count != null ? h('span', { className: 'wb-tab__n' }, t.count) : null);
    }));
  }

  function SidebarItem(props) {
    var end = null;
    if (props.count != null) end = h('span', { className: 'wb-count' }, props.count);
    else if (props.state) end = h(SeatState, { state: props.state });
    else if (props.unread) end = h('span', { className: 'wb-dot', 'aria-label': 'unread' });
    else if (props.meta != null) end = h('span', { className: 'wb-mono' }, props.meta);
    return h('div', { className: cx('wb-navitem', props.active && 'wb-navitem--active', props.unread && 'wb-navitem--unread', props.child && 'wb-navitem--child'), role: 'link', tabIndex: 0 },
      props.avatar ? h(Avatar, props.avatar) : null, props.children, end ? h('span', { className: 'wb-navitem__end' }, end) : null);
  }

  function Menu(props) {
    return h('div', { className: 'wb-float wb-menu', role: 'menu' }, props.items.map(function (it, i) {
      if (it === '-') return h('div', { key: i, className: 'wb-menusep', role: 'separator' });
      return h('div', { key: i, role: 'menuitem', tabIndex: -1, className: cx('wb-menuitem', it.active && 'wb-menuitem--active', it.danger && 'wb-menuitem--danger'), onClick: it.onSelect },
        it.icon ? h(Icon, { name: it.icon }) : null, it.label, it.kbd ? h(Kbd, null, it.kbd) : null);
    }));
  }

  function CommandPalette(props) {
    return h('div', { className: 'wb-float wb-cmdk', role: 'dialog', 'aria-label': 'Command menu' },
      h('div', { className: 'wb-cmdk__q' }, h(Icon, { name: 'search', strokeWidth: 1.75 }), h('input', { defaultValue: props.query, placeholder: 'Type a command, search, or ask @op…', 'aria-label': 'Command' })),
      props.groups.map(function (g, gi) {
        return h(React.Fragment, { key: gi }, h('div', { className: 'wb-cmdk__group' }, g.name),
          g.items.map(function (it, i) {
            return h('div', { key: i, className: cx('wb-cmdk__item', it.active && 'wb-cmdk__item--active'), role: 'option', 'aria-selected': !!it.active },
              it.avatar ? h(Avatar, Object.assign({ size: 'xs' }, it.avatar)) : it.task ? h(TaskState, { state: it.task }) : it.icon ? h(Icon, { name: it.icon }) : null,
              it.label, h('span', { className: 'wb-cmdk__end' }, it.path ? h('span', { className: 'wb-mono' }, it.path) : null, it.state ? h(SeatState, { state: it.state }) : null, it.kbd ? h(Kbd, null, it.kbd) : null));
          }));
      }),
      h('div', { className: 'wb-cmdk__foot' }, h('span', null, '↑↓ move'), h('span', null, '↵ open'), h('span', null, '⇧↵ ask @op'), h('span', { style: { marginLeft: 'auto' } }, 'esc')));
  }

  function Toast(props) {
    return h('div', { className: cx('wb-float wb-toast', props.tone === 'danger' && 'wb-toast--danger'), role: 'status' },
      h(Icon, { name: props.tone === 'danger' ? 'x' : 'check', strokeWidth: 2 }),
      h('span', null, props.children, props.cursor ? h('span', { className: 'wb-mono' }, ' ' + props.cursor) : null),
      props.action ? h(Button, { variant: 'ghost', size: 'sm', kbd: props.action.kbd, onClick: props.action.onClick }, props.action.label) : null);
  }

  function NewEventsPill(props) { return h('button', { type: 'button', className: 'wb-newpill', onClick: props.onClick }, props.count + ' new ', props.direction === 'up' ? '↑' : '↓'); }

  function IssueRow(props) {
    return h('div', { className: cx('wb-issue', props.selected && 'wb-issue--selected'), role: 'row', tabIndex: 0 },
      h('span', { className: 'wb-mono' }, props.cursor), h(TaskState, { state: props.state }),
      h('span', { className: 'wb-issue__title' }, props.title),
      h('span', { className: 'wb-issue__labels' }, (props.kinds || []).map(function (k) { return h(Kind, { key: k, kind: k }); }),
        (props.labels || []).map(function (l) { return h(Label, { key: l[0], name: l[0], value: l[1] }); })),
      props.assignee ? h(Avatar, Object.assign({ size: 'xs' }, props.assignee)) : h('span'),
      h('span', { className: 'wb-mono wb-issue__time' }, props.updated));
  }

  function BoardCard(props) {
    return h('div', { className: cx('wb-card', props.state === 'held' && 'wb-card--held') },
      h('div', { className: 'wb-card__top' }, h('span', { className: 'wb-mono' }, props.cursor + (props.channel ? ' · ' + props.channel : '')), h(TaskState, { state: props.state })),
      h('div', { className: 'wb-card__title' }, props.title),
      h('div', { className: 'wb-card__foot' }, (props.kinds || []).map(function (k) { return h(Kind, { key: k, kind: k }); }),
        (props.labels || []).map(function (l) { return h(Label, { key: l[0], name: l[0], value: l[1] }); }),
        props.assignee ? h(Avatar, Object.assign({ size: 'xs' }, props.assignee)) : null,
        props.cost ? h('span', { className: 'wb-mono' }, props.cost) : null));
  }

  function Message(props) {
    var a = props.author || {};
    return h('div', { className: cx('wb-msg', props.pending && 'wb-msg--pending', props.arrive && 'wb-msg--arrive') },
      h(Avatar, { kind: a.kind, initials: a.initials, name: a.name, size: 'md' }),
      h('div', { style: { minWidth: 0 } },
        h('div', { className: 'wb-msg__head' }, h('span', { className: 'wb-msg__who' }, a.name), a.handle ? h('span', { className: 'wb-mono' }, a.handle) : null,
          h('span', { className: 'wb-mono' }, props.pending ? 'sending…' : (props.cursor ? props.cursor + ' · ' : '') + (props.time || ''))),
        h('div', { className: 'wb-msg__body' }, props.children)));
  }

  function ToolCall(props) {
    var st = props.status || 'held';
    var label = props.statusLabel || { held: 'waiting for approval', ok: 'done', failed: 'failed', running: 'running' }[st];
    return h('div', { className: 'wb-tool' },
      h('div', { className: 'wb-tool__head' }, h('b', null, props.name), h('span', { className: 'wb-tool__status--' + st }, label)),
      h('pre', null, typeof props.input === 'string' ? props.input : JSON.stringify(props.input)));
  }

  function ApprovalCard(props) {
    return h('div', { className: 'wb-approval', role: 'group', 'aria-label': props.title },
      h('div', null, h('div', { className: 'wb-approval__q' }, props.title), props.reason ? h('div', { className: 'wb-approval__why' }, props.reason) : null),
      h('div', { className: 'wb-approval__acts' },
        h(Button, { variant: 'primary', kbd: '⌘↵', onClick: props.onApprove }, props.approveLabel || 'Approve'),
        h(Button, { variant: 'outline', onClick: props.onDecline }, 'Decline'),
        h(Button, { variant: 'outline', onClick: props.onReply }, 'Reply'),
        props.run ? h('span', { className: 'wb-mono' }, props.run) : null));
  }

  window.Workbus = { Button: Button, Kbd: Kbd, Input: Input, Avatar: Avatar, SeatState: SeatState, Kind: Kind, Label: Label, HeldPill: HeldPill, TaskState: TaskState, Tabs: Tabs, SidebarItem: SidebarItem, Menu: Menu, CommandPalette: CommandPalette, Toast: Toast, NewEventsPill: NewEventsPill, IssueRow: IssueRow, BoardCard: BoardCard, Message: Message, ToolCall: ToolCall, ApprovalCard: ApprovalCard, Icon: Icon };
})();
