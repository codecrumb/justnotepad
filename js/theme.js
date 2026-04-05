(function () {
    var THEME_KEY = 'theme';

    function isDark(theme) {
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return theme === 'dark' || (theme !== 'light' && prefersDark);
    }

    function applyTheme(theme) {
        var dark = isDark(theme);
        var link = document.getElementById('theme-css');
        if (link) {
            link.href = link.getAttribute(dark ? 'data-dark' : 'data-light');
        }
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
        if (active) active.style.display = 'block';
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
                '<span id="light_mode" style="display:none"></span>' +
                '<span id="dark_mode" style="display:none"></span>';
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
