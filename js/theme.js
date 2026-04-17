(function () {
    var THEME_KEY = 'theme';

    function isDark(theme) {
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return theme === 'dark' || (theme !== 'light' && prefersDark);
    }

    function applyTheme(theme) {
        var dark = isDark(theme);
        document.documentElement.classList.toggle('dark', dark);
        if (window.inkEditor) {
            window.inkEditor.reconfigure({ options: { appearance: dark ? 'dark' : 'light' } });
        }
        var logo = document.querySelector('#logo img');
        if (logo) {
            var src = logo.getAttribute(dark ? 'data-dark-src' : 'data-light-src');
            if (src) logo.src = src;
        }
        var autoEl = document.getElementById('auto_mode');
        var lightEl = document.getElementById('light_mode');
        var darkEl = document.getElementById('dark_mode');
        if (autoEl) autoEl.style.display = 'none';
        if (lightEl) lightEl.style.display = 'none';
        if (darkEl) darkEl.style.display = 'none';
        var active = theme === 'dark' ? darkEl : theme === 'light' ? lightEl : autoEl;
        if (active) active.style.display = 'inline-flex';
    }

    function cycleTheme() {
        var cur = localStorage.getItem(THEME_KEY) || 'auto';
        var next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
        if (next === 'auto') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, next);
        applyTheme(next);
    }

    function setup() {
        if (!document.getElementById('style_mode')) {
            var div = document.createElement('div');
            div.id = 'style_mode';
            div.className = 'floating';
            div.innerHTML = '<span id="auto_mode"></span>' +
                '<span id="light_mode" style="display:none"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg></span>' +
                '<span id="dark_mode" style="display:none"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg></span>';
            document.body.appendChild(div);
        }
        applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
        var spans = document.querySelectorAll('#style_mode span');
        for (var i = 0; i < spans.length; i++) {
            spans[i].addEventListener('click', cycleTheme);
        }
    }

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
            if (!localStorage.getItem(THEME_KEY)) applyTheme('auto');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
