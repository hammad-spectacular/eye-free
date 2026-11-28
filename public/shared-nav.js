/**
 * Shared Navigation Renderer and Dropdown Handler
 * Renders the role-specific menu into #tabNavInner based on MENU_CONFIG.
 * Preserves exact ids, data-section attributes, and mobile toggle behaviors.
 * Handles mouse hover, keyboard focus, tap (phones), and Esc key navigation.
 */
(function () {
  'use strict';


  // Inline SVG icons for the rail — font-independent, always visible.
  var NAV_ICONS = {
    'fa-house': '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
    'fa-user-graduate': '<path d="M2 9.5 12 4l10 5.5-10 5.5z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 9.5V15"/>',
    'fa-book-open': '<path d="M2 5.5C4 4 7 3.5 12 3.5S20 4 22 5.5V19c-2-1.5-5-2-10-2s-8 .5-10 2z"/><path d="M12 3.5v14"/>',
    'fa-clipboard-check': '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5a3 3 0 0 1 6 0"/><path d="m9 13.5 2 2 4-4.5"/>',
    'fa-hand-holding-dollar': '<circle cx="14" cy="6.5" r="4.5"/><path d="M14 3.8v5.4M15.6 5.3c-.3-.6-.9-.9-1.6-.9-.9 0-1.6.5-1.6 1.2 0 1.6 3.4.8 3.4 2.4 0 .7-.7 1.2-1.8 1.2-.8 0-1.4-.3-1.8-.9"/><path d="M2 14l4-1.2 1.8 5.6-4 1.2z"/><path d="M8 13.4l3-.6c.9-.2 1.7 0 2.4.5l1.3.9 5.6-.5c1 0 1.5 1.2.7 1.8l-.9.7-5.2 1.9c-.6.2-1.3.2-1.9 0L8.6 17z"/>',
    'fa-users': '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.6"/><path d="M18 14.5c2 .7 3.2 2.4 3.5 4.5"/>',
    'fa-calendar-check': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m9.5 15.5 1.8 1.8 3.4-3.6"/>',
    'fa-circle-exclamation': '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5v.5"/>',
    'fa-building': '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M10 21v-3h4v3"/>',
    'fa-chart-bar': '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
    'fa-bullhorn': '<path d="M3 10v4l4 .5V9.5z"/><path d="M7 9.5 18 5v14l-11-4.5"/><path d="M18 10a3 3 0 0 1 0 4"/>',
    'fa-ellipsis': '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    'fa-clock-rotate-left': '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
    'fa-book': '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    'fa-user': '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    'fa-chevron-down': '<path d="m6 9 6 6 6-6"/>'
  };
  function navIcon(iconClass) {
    var name = String(iconClass || '').replace(/^fa(s|r|b|solid|regular|brands)?-?/, 'fa-');
    var inner = NAV_ICONS[iconClass] || NAV_ICONS[name];
    if (!inner) return '<i class="fas ' + iconClass + '"></i>';
    return '<svg class="nav-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  function initSharedNav(role) {
    const container = document.getElementById('tabNavInner');
    if (!container) return;

    // Safe fallback: if MENU_CONFIG is missing or role is not defined, keep existing HTML intact
    if (!window.MENU_CONFIG || !window.MENU_CONFIG[role]) {
      console.warn('[shared-nav] MENU_CONFIG for role "' + role + '" not found. Retaining fallback navigation.');
      setupDropdownEvents(container);
      return;
    }

    const items = window.MENU_CONFIG[role];
    let html = '';

    items.forEach(item => {
      if (item.dropdown && item.dropdown.length > 0) {
        const secAttr = item.dataSection ? `data-section="${item.dataSection}"` : '';
        const activeSectionsAttr = Array.isArray(item.activeSections)
          ? `data-active-sections="${item.activeSections.join(' ')}"`
          : '';
        // A dropdown parent keeps the feature key so the whole menu item is still
        // gated (and hidden) when the tenant has that module switched off.
        const featAttr = item.dataFeatureKey ? `data-feature-key="${item.dataFeatureKey}"` : '';
        const tipAttr = `data-tooltip="${item.label}"`;
        html += `
          <div class="nav-tab-item" id="${item.id}">
            <button type="button" class="tab-btn" aria-haspopup="true" aria-expanded="false" aria-controls="${item.id}-menu" ${secAttr} ${activeSectionsAttr} ${featAttr} ${tipAttr}>
              ${item.icon ? navIcon(item.icon) : ''}
              <span>${item.label}</span>
              ${navIcon('fa-chevron-down').replace('class="nav-ico"', 'class="nav-ico nav-arrow')}
            </button>
            <div class="nav-dropdown" id="${item.id}-menu" role="menu">
              <div class="nav-dropdown-inner">
              ${item.dropdown.map(sub => {
                const toastAttr = sub.toast ? `onclick="if(window.showToast){showToast('${sub.toast}','info');}else{alert('${sub.toast}');}return false;"` : '';
                const secAttr = sub.dataSection ? `data-section="${sub.dataSection}"` : '';
                const roleAttr = sub.dataRole ? `data-role="${sub.dataRole}"` : '';
                const actionAttr = sub.action ? `onclick="${sub.action}"` : '';
                
                if (sub.action) {
                  return `
                  <button type="button" class="nav-dropdown-item" role="menuitem" ${secAttr} ${roleAttr} ${actionAttr} ${toastAttr}>
                    <span class="nav-dropdown-title">${sub.label}</span>
                    ${sub.desc ? `<span class="nav-dropdown-desc">${sub.desc}</span>` : ''}
                  </button>
                  `;
                }
                return `
                <a href="${sub.href}" class="nav-dropdown-item" role="menuitem" ${secAttr} ${roleAttr} ${toastAttr}>
                  <span class="nav-dropdown-title">${sub.label}</span>
                  ${sub.desc ? `<span class="nav-dropdown-desc">${sub.desc}</span>` : ''}
                </a>
              `}).join('')}
              </div>
            </div>
          </div>
        `;
      } else {
        const idAttr = item.id && item.id !== item.dataSection ? `id="${item.id}"` : '';
        const secAttr = item.dataSection ? `data-section="${item.dataSection}"` : '';
        const featAttr = item.dataFeatureKey ? `data-feature-key="${item.dataFeatureKey}"` : '';
        const optStyle = item.optional ? 'style="display:none;"' : '';
        const actAttr = item.action ? `onclick="${item.action}"` : '';
        const clsActive = item.active ? 'active' : '';
        const tipAttr = `data-tooltip="${item.label}"`;

        if (item.action && !item.href) {
          html += `
            <button type="button" class="tab-btn ${clsActive}" ${idAttr} ${actAttr} ${secAttr} ${featAttr} ${optStyle} ${tipAttr}>
              ${item.icon ? navIcon(item.icon) : ''}
              <span>${item.label}</span>
            </button>
          `;
        } else if (item.href) {
          html += `
            <a href="${item.href}" class="tab-btn ${clsActive}" ${idAttr} ${actAttr} ${secAttr} ${featAttr} ${optStyle} ${tipAttr}>
              ${item.icon ? navIcon(item.icon) : ''}
              <span>${item.label}</span>
            </a>
          `;
        } else {
          // For dropdown items with actions
          html += `
            <button type="button" class="tab-btn ${clsActive}" ${idAttr} ${actAttr} ${secAttr} ${featAttr} ${optStyle} ${tipAttr}>
              ${item.icon ? navIcon(item.icon) : ''}
              <span>${item.label}</span>
            </button>
          `;
        }
      }
    });

    container.innerHTML = html;
    setupDropdownEvents(container);
  }

  function setupDropdownEvents(container) {
    if (!container) return;
    const dropdownWrappers = container.querySelectorAll('.nav-tab-item');

    function closeAllDropdowns() {
      dropdownWrappers.forEach(wrap => {
        wrap.classList.remove('open');
        const btn = wrap.querySelector('.tab-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        const dd = wrap.querySelector('.nav-dropdown');
        if (dd) {
          dd.style.opacity = '0';
          dd.style.visibility = 'hidden';
          dd.style.pointerEvents = 'none';
        }
      });
    }

    function positionDropdown(wrap) {
      return; // accordion layout — no flyout positioning
      const btn = wrap.querySelector('.tab-btn');
      const dd = wrap.querySelector('.nav-dropdown');
      if (!btn || !dd) return;
      const rect = btn.getBoundingClientRect();
      const isFixed = getComputedStyle(dd).position === 'fixed';
      dd.style.top = (isFixed ? rect.bottom : rect.bottom + window.scrollY) + 'px';
      dd.style.left = rect.left + 'px';
      dd.style.minWidth = rect.width + 'px';
      dd.style.opacity = '1';
      dd.style.visibility = 'visible';
      dd.style.pointerEvents = 'auto';
    }

    dropdownWrappers.forEach(wrap => {
      const btn = wrap.querySelector('.tab-btn');
      let closeTimeout = null;
      let lastHoverTime = 0;

      // Mouse enter / leave with smooth 120ms dismissal buffer (desktop only)
      wrap.addEventListener('mouseenter', () => {
        if (window.innerWidth <= 768) return;
        lastHoverTime = Date.now();
        clearTimeout(closeTimeout);
        closeAllDropdowns();
        wrap.classList.add('open');
        if (btn) btn.setAttribute('aria-expanded', 'true');
        positionDropdown(wrap);
      });

      wrap.addEventListener('mouseleave', () => {
        if (window.innerWidth <= 768) return;
        closeTimeout = setTimeout(() => {
          wrap.classList.remove('open');
          if (btn) btn.setAttribute('aria-expanded', 'false');
          const dd = wrap.querySelector('.nav-dropdown');
          if (dd) {
            dd.style.opacity = '0';
            dd.style.visibility = 'hidden';
            dd.style.pointerEvents = 'none';
          }
        }, 120);
      });

      // Keep dropdown open while mouse moves from tab to list
      const dd = wrap.querySelector('.nav-dropdown');
      if (dd) {
        dd.addEventListener('mouseenter', () => {
          clearTimeout(closeTimeout);
          wrap.classList.add('open');
          if (btn) btn.setAttribute('aria-expanded', 'true');
          dd.style.opacity = '1';
          dd.style.visibility = 'visible';
          dd.style.pointerEvents = 'auto';
        });
        dd.addEventListener('mouseleave', () => {
          if (window.innerWidth <= 768) return;
          closeTimeout = setTimeout(() => {
            wrap.classList.remove('open');
            if (btn) btn.setAttribute('aria-expanded', 'false');
            dd.style.opacity = '0';
            dd.style.visibility = 'hidden';
            dd.style.pointerEvents = 'none';
          }, 120);
        });
      }

      // Keyboard click or tap toggle
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // If desktop hover just opened it in the last 400ms, keep it open on click
          if (Date.now() - lastHoverTime < 400 && wrap.classList.contains('open')) {
            return;
          }
          const isOpen = wrap.classList.contains('open');
          closeAllDropdowns();
          if (!isOpen) {
            wrap.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
            positionDropdown(wrap);
          }
        });
      }

      wrap.addEventListener('focusout', (e) => {
        if (!wrap.contains(e.relatedTarget)) {
          wrap.classList.remove('open');
          if (btn) btn.setAttribute('aria-expanded', 'false');
          const dd = wrap.querySelector('.nav-dropdown');
          if (dd) {
            dd.style.opacity = '0';
            dd.style.visibility = 'hidden';
            dd.style.pointerEvents = 'none';
          }
        }
      });
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        closeAllDropdowns();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllDropdowns();
      }
    });

    // Reposition open dropdowns on scroll and resize
    let scrollTimeout = null;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        dropdownWrappers.forEach(wrap => {
          if (wrap.classList.contains('open')) {
            positionDropdown(wrap);
          }
        });
      }, 50);
    });
    window.addEventListener('resize', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        dropdownWrappers.forEach(wrap => {
          if (wrap.classList.contains('open')) {
            positionDropdown(wrap);
          }
        });
      }, 50);
    });
  }

  window.initSharedNav = initSharedNav;
  window.setupDropdownEvents = setupDropdownEvents;
})();
