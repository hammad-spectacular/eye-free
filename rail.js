/* Shared left-rail expand/collapse behaviour.
 * Desktop (hover-capable, >=1024px): the rail is a 76px icon strip; a class
 * 'rail-open' expands it to a 264px overlay. Driven by pointer events with
 * open/close delays — NOT :hover/:focus-within CSS, so it always closes.
 */
(function () {
  'use strict';
  const OPEN_DELAY = 120;
  const CLOSE_DELAY = 250;

  function isDesktop() {
    return window.innerWidth >= 1024 && window.matchMedia('(hover:hover) and (pointer:fine)').matches;
  }

  function setupRail() {
    const sidebar = document.getElementById('eyeSidebar');
    if (!sidebar || sidebar.dataset.railBound) return;
    sidebar.dataset.railBound = '1';
    let openTimer = null, closeTimer = null;

    function open() {
      clearTimeout(closeTimer);
      if (isDesktop() && !sidebar.classList.contains('rail-open')) {
        clearTimeout(openTimer);
        openTimer = setTimeout(() => sidebar.classList.add('rail-open'), OPEN_DELAY);
      }
    }
    function close() {
      clearTimeout(openTimer);
      if (sidebar.classList.contains('rail-open')) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => sidebar.classList.remove('rail-open'), CLOSE_DELAY);
      }
    }
    function closeNow() {
      clearTimeout(openTimer); clearTimeout(closeTimer);
      sidebar.classList.remove('rail-open');
    }

    sidebar.addEventListener('pointerenter', open);
    sidebar.addEventListener('pointerleave', close);
    // keyboard: expand on focus-visible of a nav control, collapse on Esc/blur-out
    sidebar.addEventListener('focusin', (e) => {
      if (e.target.matches(':focus-visible')) open();
    });
    sidebar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeNow(); if (document.activeElement) document.activeElement.blur(); }
    });
    // clicking a nav item: let navigation happen, then close + blur so it can't reopen
    sidebar.addEventListener('click', (e) => {
      const link = e.target.closest('a, button');
      if (!link) return;
      if (link.classList.contains('nav-dropdown-btn') || link.getAttribute('aria-expanded') !== null) return;
      setTimeout(() => { closeNow(); link.blur(); }, 0);
    });
    // route change closes it
    window.addEventListener('hashchange', closeNow);
    // pointer leaving the browser window closes it
    document.documentElement.addEventListener('mouseleave', closeNow);
    window.addEventListener('blur', closeNow);
    // any programmatic rail-open class removal request
    sidebar.addEventListener('railclose', closeNow);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupRail);
  } else {
    setupRail();
  }
})();
