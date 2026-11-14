/**
 * Shared Navigation Renderer and Dropdown Handler
 * Renders the role-specific menu into #tabNavInner based on MENU_CONFIG.
 * Preserves exact ids, data-section attributes, and mobile toggle behaviors.
 * Handles mouse hover, keyboard focus, tap (phones), and Esc key navigation.
 */
(function () {
  'use strict';

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
        html += `
          <div class="nav-tab-item" id="${item.id}">
            <button type="button" class="tab-btn" aria-haspopup="true" aria-expanded="false" ${secAttr} ${activeSectionsAttr} ${featAttr}>
              ${item.icon ? `<i class="fas ${item.icon}"></i>` : ''}
              <span>${item.label}</span>
              <i class="fas fa-chevron-down nav-arrow" aria-hidden="true"></i>
            </button>
            <div class="nav-dropdown" role="menu">
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
        `;
      } else {
        const idAttr = item.id && item.id !== item.dataSection ? `id="${item.id}"` : '';
        const secAttr = item.dataSection ? `data-section="${item.dataSection}"` : '';
        const featAttr = item.dataFeatureKey ? `data-feature-key="${item.dataFeatureKey}"` : '';
        const optStyle = item.optional ? 'style="display:none;"' : '';
        const actAttr = item.action ? `onclick="${item.action}"` : '';
        const clsActive = item.active ? 'active' : '';

        if (item.action && !item.href) {
          html += `
            <button type="button" class="tab-btn ${clsActive}" ${idAttr} ${actAttr} ${secAttr} ${featAttr} ${optStyle}>
              ${item.icon ? `<i class="fas ${item.icon}"></i>` : ''}
              <span>${item.label}</span>
            </button>
          `;
        } else if (item.href) {
          html += `
            <a href="${item.href}" class="tab-btn ${clsActive}" ${idAttr} ${actAttr} ${secAttr} ${featAttr} ${optStyle}>
              ${item.icon ? `<i class="fas ${item.icon}"></i>` : ''}
              <span>${item.label}</span>
            </a>
          `;
        } else {
          // For dropdown items with actions
          html += `
            <button type="button" class="tab-btn ${clsActive}" ${idAttr} ${actAttr} ${secAttr} ${featAttr} ${optStyle}>
              ${item.icon ? `<i class="fas ${item.icon}"></i>` : ''}
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
      const btn = wrap.querySelector('.tab-btn');
      const dd = wrap.querySelector('.nav-dropdown');
      if (!btn || !dd) return;
      const rect = btn.getBoundingClientRect();
      dd.style.top = (rect.bottom + window.scrollY) + 'px';
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
