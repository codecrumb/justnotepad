/*
 * Copyright (c) JustNotepad
 * https://justnotepad.pages.dev/
 * Uses IndexedDB via NoteDB wrapper
*/
$(document).ready(function() {

    // Fire the ink-mde import IMMEDIATELY — before any await — so a storage
    // failure can never block the editor from loading.
    var inkModulePromise = import('./ink-mde/0.34.0/ink-mde.js').catch(function() { return import('https://esm.sh/ink-mde'); });

    (async function initApp() {

    var draft_id;
    var value;
    var date;
    var month_name = new Array("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec");
    var save_the_world_message = '<h1>Save Paper. Save Trees. Save the World.</h1><h2>It seems that your text more than 2 sheets of paper...</h2><p>If you want to send your text to your friend or to another device, you can just create a "Temporary link" to sync your text.</p><p>https://justnotepad.pages.dev/faq/#16</p><p>Thanks ;-)</p>';
    var default_page_title = 'JustNotepad - Online notepad';
    var status_value_from_url = '';
    var inkEditor = null;
    var editor_updating = false;
    var saveTimer = null;

    function showAppToast(msg) {
        var $t = $('#sync-toast');
        $t.text(msg).stop(true).fadeIn(200);
        clearTimeout(window._appToastTimer);
        window._appToastTimer = setTimeout(function() { $t.fadeOut(400); }, 3000);
    }

    //-----------------------------------------------------------------------------------------------
    // One-time migration: move jStorage data into IndexedDB on first run.
    async function migrateFromJStorage() {
        var raw = localStorage.getItem('__jstorage');
        if (!raw) return;
        try {
            var parsed = JSON.parse(raw);
            var oldDrafts = parsed['drafts'];
            var oldLastId = parsed['last_modified_id'];
            if (Array.isArray(oldDrafts) && oldDrafts.length > 0) {
                await NoteDB.putAll(oldDrafts);
            }
            if (oldLastId) {
                sessionStorage.setItem('last_modified_id', oldLastId);
            }
            localStorage.removeItem('__jstorage'); // only removed after successful write
        } catch(e) {
            console.warn('jStorage migration failed (will retry next load):', e);
        }
    }


    //-----------------------------------------------------------------------------------------------
    // Purge trashed notes older than the retention period:
    async function purgeExpiredTrash() {
        var retention = parseInt(localStorage.getItem('trash_retention') || '30', 10);
        if (retention === 0) return; // forever
        var cutoff = Math.round(Date.now() / 1000) - retention * 86400;
        var all;
        try { all = await NoteDB.getAll(); } catch(e) { return; }
        for (var pi = 0; pi < all.length; pi++) {
            if (all[pi].trashed && all[pi].deletedAt && all[pi].deletedAt < cutoff) {
                try { await NoteDB.delete(all[pi].id); } catch(e) {}
            }
        }
    }

    //-----------------------------------------------------------------------------------------------
    // Open DB and migrate, then load drafts. Editor always initializes even if this fails.
    var drafts = null;
    var last_modified_id = null;
    try {
        await NoteDB.open();
        await migrateFromJStorage();
        await purgeExpiredTrash();
        // Clean up temp notes that don't belong to this tab's session
        var _tempIds = JSON.parse(sessionStorage.getItem('temp_note_ids') || '[]');
        var _allForCleanup = await NoteDB.getAll();
        for (var _d of _allForCleanup) {
            if (_d.is_temp && !_tempIds.includes(_d.id)) {
                try { await NoteDB.delete(_d.id); } catch(e) {}
            }
        }
        var allDrafts = await NoteDB.getAll();
        var activeDrafts = allDrafts.filter(function(d) { return !d.trashed; });
        drafts = (activeDrafts.length > 0) ? activeDrafts : null;
    } catch(e) {
        console.error('Storage init failed:', e);
        showAppToast('Storage unavailable \u2014 notes may not be saved');
    }


    //-----------------------------------------------------------------------------------------------
    // Resolve last_modified_id and draft_id from raw localStorage:
    if (status_value_from_url == 'yes') {
        sessionStorage.removeItem('last_modified_id');
    } else {
        last_modified_id = sessionStorage.getItem('last_modified_id');
    }

    if (!last_modified_id || status_value_from_url == 'yes') {
        draft_id = '60fe463d1c670551f5a5f470722b0efb';
    } else {
        draft_id = last_modified_id;
    }

    // If draft_id points to a trashed/nonexistent note, switch to most recent active
    if (drafts && !drafts.some(function(d) { return d.id === draft_id; })) {
        var _sortedActive = drafts.slice().sort(function(a, b) { return b.timestamp - a.timestamp; });
        draft_id = _sortedActive[0].id;
        sessionStorage.setItem('last_modified_id', draft_id);
    }


    //-----------------------------------------------------------------------------------------------
    function count_value(value) {
        $('#count #count_chars').text('Characters: ' + value.length + ' (with spaces)');
        if (value.length === 0 || value.match(/^\s*$/)) {
            $('#count #count_words').text('Words: 0');
        } else {
            $('#count #count_words').text('Words: ' + value.trim().replace(/\s+/gi, ' ').split(' ').length);
        }
    }

    function change_page_title(value) {
        var short_page_title_value = value.trim().replace(/\s\s+/g, ' ').slice(0, 25).trim();
        document.title = '"' + short_page_title_value + '..." \u2013 Draft \u2013 JustNotepad';
    }


    //-----------------------------------------------------------------------------------------------
    // Initialize UI from loaded drafts:
    if (!drafts) {
        $('#buttons #delete_draft').hide();
        $('#create_temp_url').hide(); $('#download_note').hide();
    } else {
        for (var a = 0; a < drafts.length; a++) {
            if (drafts[a].id == draft_id) {
                value = drafts[a].value;
                date = new Date(drafts[a].timestamp * 1000);
                break;
            }
        }
        if (!value || status_value_from_url == 'yes') {
            $('#buttons #delete_draft').hide();
            $('#create_temp_url').hide(); $('#download_note').hide();
        } else {
            // Auto-skip very large last draft to prevent browser freeze (>1M chars):
            for (var b = 0; b < drafts.length; b++) {
                if ((drafts[b].id == last_modified_id) && (drafts[b].value.length > 1000000)) {
                    sessionStorage.removeItem('last_modified_id');
                    location.reload(true);
                    break;
                }
            }
            if (value.length < 10000) {
                $('#printable_text').text(value);
            } else {
                $('#printable_text').html(save_the_world_message);
            }
            $('#buttons #delete_draft').show();
            $('#create_temp_url').show(); $('#download_note').show();
            count_value(value);
            $('#count').show();
            $('#status_text').html('Saved on ' + month_name[date.getMonth()] + '&nbsp;' + date.getDate() + ', ' + date.getFullYear() + ', at ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2) + ':' + ('0' + date.getSeconds()).slice(-2));
            $('#status_text_by_default').hide();
            $('#status_text').show();
        }
    }


    //-----------------------------------------------------------------------------------------------
    // Initialize ink-mde (await the already-loading promise — never blocked by storage):
    try {
        var inkModule = await inkModulePromise;
        var ink = inkModule.default;
        var theme = localStorage.getItem('theme');
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches;
        var appearance = (theme === 'dark' || (theme !== 'light' && prefersDark)) ? 'dark' : 'light';
        inkEditor = ink(document.getElementById('editable_text'), {
            doc: value || '',
            interface: { images: true },
            hooks: {
                afterUpdate: function() {
                    if (!editor_updating) save();
                }
            }
        });
        window.inkEditor = inkEditor;
        // Obsidian-style live preview: hide syntax markers (**, #, _, etc.) on non-cursor lines.
        // ink-mde doesn't include highlightActiveLine so we track the active line ourselves.
        // We find the dynamically generated CSS class for processing instructions at runtime
        // by scanning injected stylesheets, then toggle .ink-active-line on the cursor's line.
        (function applyMarkdownPreview() {
            var processingCls = null;
            for (var i = 0; i < document.styleSheets.length; i++) {
                try {
                    var rules = document.styleSheets[i].cssRules;
                    for (var j = 0; j < rules.length; j++) {
                        var rule = rules[j];
                        if (rule.selectorText &&
                            rule.selectorText.charAt(0) === '.' &&
                            rule.selectorText.indexOf(' ') === -1 &&
                            rule.style && rule.style.length === 1 &&
                            rule.cssText.indexOf('--ink-internal-syntax-processing-instruction-color') !== -1) {
                            processingCls = rule.selectorText;
                            break;
                        }
                    }
                } catch(e) { /* cross-origin sheets */ }
                if (processingCls) break;
            }
            if (!processingCls) return;

            var s = document.createElement('style');
            s.id = 'ink-md-preview';
            s.textContent = '#editable_text_box .cm-line:not(.ink-active-line) ' + processingCls + ' { display: none; }';
            document.head.appendChild(s);

            var editorEl = document.getElementById('editable_text');

            function updateActiveLine() {
                var lines = editorEl.querySelectorAll('.cm-line');
                for (var k = 0; k < lines.length; k++) lines[k].classList.remove('ink-active-line');

                // Primary: use window.getSelection() to find which .cm-line the cursor is in
                var sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                    var anchor = sel.anchorNode;
                    if (anchor && editorEl.contains(anchor)) {
                        var el = anchor.nodeType === 3 ? anchor.parentElement : anchor;
                        var line = el.closest && el.closest('.cm-line');
                        if (line) { line.classList.add('ink-active-line'); return; }
                    }
                }

                // Fallback: match cursor element to line by vertical position
                var cursor = editorEl.querySelector('.cm-cursor-primary') || editorEl.querySelector('.cm-cursor');
                if (!cursor) return;
                var cr = cursor.getBoundingClientRect();
                if (!cr.height) return;
                var mid = cr.top + cr.height / 2;
                for (var k = 0; k < lines.length; k++) {
                    var r = lines[k].getBoundingClientRect();
                    if (mid >= r.top && mid < r.bottom) { lines[k].classList.add('ink-active-line'); break; }
                }
            }

            document.addEventListener('selectionchange', function() {
                requestAnimationFrame(updateActiveLine);
            });
            document.addEventListener('keydown', function() {
                requestAnimationFrame(updateActiveLine);
            });
            editorEl.addEventListener('mousedown', function() {
                requestAnimationFrame(updateActiveLine);
            });
        })();
    } catch(e) {
        console.error('ink-mde failed to load:', e);
    }


    //-----------------------------------------------------------------------------------------------
    // Click anywhere in the editor area to focus the editor:
    $('#editable_text_box').on('click', function(e) {
        if (inkEditor && !$(e.target).closest('.cm-editor')[0]) {
            inkEditor.focus();
        }
    });

    // Ctrl/Cmd+Click on a link or image to open its URL:
    $('#editable_text_box').on('click', function(e) {
        if (!e.ctrlKey && !e.metaKey) return;
        if (!inkEditor) return;
        var target = e.target;
        var line = target.closest ? target.closest('.cm-line') : null;
        if (!line) return;
        var lineText = line.textContent;
        var linkRegex = /!?\[([^\]]*)\]\(([^)]+)\)/g;
        var match;
        var clickedText = target.textContent || '';
        var firstUrl = null;
        while ((match = linkRegex.exec(lineText)) !== null) {
            var url = match[2].trim();
            if (!firstUrl) firstUrl = url;
            if (match[1] === clickedText || match[2].trim() === clickedText) {
                window.open(url, '_blank', 'noopener,noreferrer');
                return;
            }
        }
        if (firstUrl) window.open(firstUrl, '_blank', 'noopener,noreferrer');
    });


    //-----------------------------------------------------------------------------------------------
    // Keyboard shortcuts:
    document.addEventListener('keydown', function(e) {
        var meta = e.ctrlKey || e.metaKey;
        if (!meta) return;
        var k = e.key.toLowerCase();
        if (e.shiftKey && k === 'n') { e.preventDefault(); $('#sidebar-new-btn').trigger('click'); return; }
        if (e.shiftKey && k === 's') { e.preventDefault(); if (inkEditor) inkEditor.wrap({ before: '~~', after: '~~' }); return; }
        if (e.shiftKey || !inkEditor) return;
        if      (k === 'b') { e.preventDefault(); inkEditor.format('bold'); }
        else if (k === 'i') { e.preventDefault(); inkEditor.format('italic'); }
        else if (k === 'e') { e.preventDefault(); inkEditor.format('code'); }
        else if (k === 'k') { e.preventDefault(); inkEditor.wrap({ before: '[', after: ']()' }); }
    });


    //-----------------------------------------------------------------------------------------------
    // Debounced save (300ms) — ink-mde fires afterUpdate on every keystroke:
    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(doSave, 300);
    }

    async function doSave() {
        if (editor_updating) return;
        var new_value = inkEditor ? inkEditor.getDoc() : '';
        var timestamp = Math.round(new Date().getTime() / 1000);
        var date = new Date(timestamp * 1000);
        var max_storage_size = 2500000 - 250;
        var error_message = 'You have reached the maximum space of your drafts.\r\nYou can delete unused drafts to free up space of drafts via "Delete" button.';
        var error_message2 = 'Your text is very large. Or you have reached the maximum space of your drafts.\r\nYou can delete unused drafts to free up space of drafts via "Delete" button.';

        // Check total character size across all drafts:
        var current_stored_value = '';
        var sum_of_lengths = 0;
        try {
            var allDrafts = await NoteDB.getAll();
            for (var d = 0; d < allDrafts.length; d++) {
                sum_of_lengths += allDrafts[d].value.length + 100;
                if (allDrafts[d].id == draft_id) {
                    if (allDrafts[d].trashed) return; // don't write to a trashed note
                    current_stored_value = allDrafts[d].value;
                }
            }
        } catch(e) { /* storage unavailable — size check skipped */ }
        var new_sum_of_lengths = (sum_of_lengths - current_stored_value.length) + new_value.length;

        if ((new_value.length >= max_storage_size) || (new_sum_of_lengths >= max_storage_size)) {
            if (((new_value.length - max_storage_size) > 1) || ((new_sum_of_lengths - max_storage_size) > 1) || ((new_value.length - current_stored_value.length) > 1)) {
                editor_updating = true; if (inkEditor) inkEditor.update(current_stored_value); editor_updating = false;
                new_value = current_stored_value;
                alert(error_message2);
            } else {
                editor_updating = true; if (inkEditor) inkEditor.update(new_value.slice(0, -1)); editor_updating = false;
                new_value = new_value.slice(0, -1);
                $('#limit_notice div').text(error_message);
                $('#limit_notice').show();
                alert(error_message);
            }
        } else {
            $('#limit_notice').hide();
        }

        try {
            var _saveTempIds = JSON.parse(sessionStorage.getItem('temp_note_ids') || '[]');
            var _saveObj = { id: draft_id, timestamp: timestamp, value: new_value };
            if (_saveTempIds.includes(draft_id)) _saveObj.is_temp = true;
            await NoteDB.put(_saveObj);
            sessionStorage.setItem('last_modified_id', draft_id);
            if (GistSync.isConnected()) GistSync.schedulePush();
        } catch(e) {
            console.error('Save failed:', e);
            showAppToast('Save failed \u2014 storage may be full or unavailable');
            return;
        }

        if (new_value.length < 10000) { $('#printable_text').text(new_value); } else { $('#printable_text').html(save_the_world_message); }
        $('#buttons #delete_draft').show();
        $('#create_temp_url').show(); $('#download_note').show();
        $('#count').show();
        $('#status_text_by_default').hide();
        $('#status_text').show();
        count_value(new_value);
        $('#status_text').html('Saved in your browser storage as draft on ' + month_name[date.getMonth()] + '&nbsp;' + date.getDate() + ', ' + date.getFullYear() + ', at ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2) + ':' + ('0' + date.getSeconds()).slice(-2));
        change_page_title(new_value);
    }


    //-----------------------------------------------------------------------------------------------
    // Generates a random 32-char hex ID for new drafts:
    function generate_id() {
        var s = '', h = '0123456789abcdef';
        for (var i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
        return s;
    }


    //-----------------------------------------------------------------------------------------------
    // Reset Telegraph share box when switching notes:
    function reset_telegraph_box() {
        $('#temp_url_box').hide();
        $('#temp_url_result').hide().html('');
        $('#temp_url_buttons').show();
        $('#another_temp_url').hide();
        $('#create_url').prop('disabled', false).removeClass('preloader_button');
    }


    //-----------------------------------------------------------------------------------------------
    // Download note as .md or .txt:
    async function download_note(ext) {
        var content = inkEditor ? inkEditor.getDoc() : '';
        if (!content) return;
        var rawName;
        try {
            var allD = await NoteDB.getAll();
            var cur = allD.find(function(d) { return d.id === draft_id; });
            rawName = (cur && cur.name) || content.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 60);
        } catch(e) {
            rawName = content.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 60);
        }
        var filename = (rawName || 'note').replace(/[^a-zA-Z0-9 \-_]/g, '').trim().replace(/\s+/g, '_') || 'note';
        var blob = new Blob([content], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename + '.' + ext;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    }
    $('#download_md').click(function() { download_note('md'); });


    //-----------------------------------------------------------------------------------------------
    // Delete the current draft if empty (called before switching/creating):
    async function delete_current_if_empty() {
        var doc = inkEditor ? inkEditor.getDoc() : '';
        if (doc.trim() !== '') return;
        try { await NoteDB.delete(draft_id); } catch(e) {}
    }


    //-----------------------------------------------------------------------------------------------
    // Sidebar tab click (event delegation - bound once):
    $('#sidebar-tabs-list').on('click', '.sidebar-tab', async function(e) {
        if ($(e.target).hasClass('tab-delete')) return;
        var clicked_id = $(this).data('id');
        if (clicked_id === draft_id) return;
        await delete_current_if_empty();
        var d;
        try { d = await NoteDB.getAll(); } catch(e) { return; }
        if (!d) return;
        for (var h = 0; h < d.length; h++) {
            if (d[h].id === clicked_id) {
                draft_id = clicked_id;
                var v = d[h].value;
                var dt = new Date(d[h].timestamp * 1000);
                editor_updating = true; if (inkEditor) inkEditor.update(v); editor_updating = false;
                if (v.length < 10000) { $('#printable_text').text(v); } else { $('#printable_text').html(save_the_world_message); }
                count_value(v);
                $('#count').show();
                $('#status_text').html('Saved in your browser storage as draft on ' + month_name[dt.getMonth()] + '&nbsp;' + dt.getDate() + ', ' + dt.getFullYear() + ', at ' + ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2) + ':' + ('0' + dt.getSeconds()).slice(-2));
                $('#status_text_by_default').hide();
                $('#status_text').show();
                reset_telegraph_box();
                $('#create_temp_url').show(); $('#download_note').show();
                change_page_title(v);
                sessionStorage.setItem('last_modified_id', draft_id);
                break;
            }
        }
        $('#sidebar-tabs-list .sidebar-tab').removeClass('active');
        $(this).addClass('active');
    });
    // Move note to Trash via × button (soft delete, event delegation - bound once):
    $('#sidebar-tabs-list').on('click', '.tab-delete', async function(e) {
        e.stopPropagation();
        var del_id = $(this).closest('.sidebar-tab').data('id');
        try { await NoteDB.trash(del_id); } catch(e) {}
        if (GistSync.isConnected()) GistSync.schedulePush();
        if (del_id === draft_id) {
            var remaining;
            try { remaining = await NoteDB.getActive(); } catch(e) { remaining = []; }
            if (remaining && remaining.length > 0) {
                remaining.sort(function(a,b){return b.timestamp-a.timestamp;});
                draft_id = remaining[0].id;
                var v2 = remaining[0].value;
                var dt2 = new Date(remaining[0].timestamp * 1000);
                editor_updating = true; if (inkEditor) inkEditor.update(v2); editor_updating = false;
                if (v2.length < 10000) { $('#printable_text').text(v2); } else { $('#printable_text').html(save_the_world_message); }
                count_value(v2);
                $('#count').show();
                $('#status_text').html('Saved in your browser storage as draft on ' + month_name[dt2.getMonth()] + '&nbsp;' + dt2.getDate() + ', ' + dt2.getFullYear() + ', at ' + ('0' + dt2.getHours()).slice(-2) + ':' + ('0' + dt2.getMinutes()).slice(-2) + ':' + ('0' + dt2.getSeconds()).slice(-2));
                $('#status_text_by_default').hide();
                $('#status_text').show();
                reset_telegraph_box();
                $('#create_temp_url').show(); $('#download_note').show();
                sessionStorage.setItem('last_modified_id', draft_id);
            } else {
                draft_id = generate_id();
                editor_updating = true; if (inkEditor) inkEditor.update(''); editor_updating = false;
                $('#printable_text').text('');
                sessionStorage.removeItem('last_modified_id');
                reset_telegraph_box();
                $('#count').hide();
                $('#count #count_chars, #count #count_words').text('');
                $('#status_text').hide();
                $('#status_text_by_default').show();
                $('#create_temp_url').hide(); $('#download_note').hide();
                document.title = default_page_title;
            }
        }
        list_of_drafts();
    });
    // Trash panel:
    async function renderTrashPanel() {
        var trashed;
        try { trashed = await NoteDB.getTrashed(); } catch(e) { trashed = []; }
        var $list = $('#trash-panel-list').empty();
        if (trashed.length === 0) {
            $('#trash-panel-empty-btn').hide();
            $list.html('<div id="trash-empty-state">Trash is empty</div>');
            return;
        }
        $('#trash-panel-empty-btn').show();
        trashed.sort(function(a, b) { return (b.deletedAt || 0) - (a.deletedAt || 0); });
        for (var ti = 0; ti < trashed.length; ti++) {
            var tf = trashed[ti].value.split('\n').find(function(l) { return l.trim(); }) || '';
            var tp = $('<span>').text(tf.replace(/^#+\s*/, '').trim()).html().slice(0, 80) || 'Untitled';
            var dAt = trashed[ti].deletedAt ? new Date(trashed[ti].deletedAt * 1000) : null;
            var dateStr = dAt ? month_name[dAt.getMonth()] + ' ' + dAt.getDate() + ', ' + dAt.getFullYear() : '';
            $list.append(
                '<div class="trash-item" data-id="' + trashed[ti].id + '">' +
                '<div class="trash-item-info"><div class="trash-item-preview">' + tp + '</div>' +
                (dateStr ? '<div class="trash-item-date">Deleted ' + dateStr + '</div>' : '') +
                '</div>' +
                '<span class="trash-item-restore" title="Restore"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5"/></svg></span>' +
                '<span class="trash-item-delete" title="Delete permanently">&#215;</span>' +
                '</div>'
            );
        }
    }
    $('#trash-icon').on('click', function() {
        renderTrashPanel();
        $('#trash-panel').show();
    });
    $('#trash-panel-close').on('click', function() { $('#trash-panel').hide(); });
    $('#trash-panel-list').on('click', '.trash-item-restore', async function() {
        var id = $(this).closest('.trash-item').data('id');
        try { await NoteDB.untrash(id); } catch(e) {}
        renderTrashPanel();
        list_of_drafts();
    });
    $('#trash-panel-list').on('click', '.trash-item-delete', function() {
        var perm_id = $(this).closest('.trash-item').data('id');
        $("#confirm_lightbox").html('<div id="confirm_message">Permanently delete this note? This cannot be undone.</div><div id="confirm_buttons"><div id="ok">Delete</div><div id="cancel">Cancel</div></div>');
        $("#confirm_layer").show();
        $("#confirm_lightbox").show();
        $("#confirm_layer, #confirm_lightbox #confirm_buttons #cancel").click(function() { $("#confirm_layer, #confirm_lightbox").hide(); });
        $("#confirm_lightbox #confirm_buttons #ok").click(async function() {
            try { await NoteDB.delete(perm_id); } catch(e) {}
            $("#confirm_layer, #confirm_lightbox").hide();
            renderTrashPanel();
            list_of_drafts();
        });
    });
    $('#trash-panel-empty-btn').on('click', async function() {
        var trashed;
        try { trashed = await NoteDB.getTrashed(); } catch(e) { return; }
        if (!trashed || trashed.length === 0) return;
        var msg = 'Permanently delete ' + trashed.length + ' trashed note' + (trashed.length === 1 ? '' : 's') + '? This cannot be undone.';
        $("#confirm_lightbox").html('<div id="confirm_message">' + msg + '</div><div id="confirm_buttons"><div id="ok">Delete</div><div id="cancel">Cancel</div></div>');
        $("#confirm_layer").show();
        $("#confirm_lightbox").show();
        $("#confirm_layer, #confirm_lightbox #confirm_buttons #cancel").click(function() { $("#confirm_layer, #confirm_lightbox").hide(); });
        $("#confirm_lightbox #confirm_buttons #ok").click(async function() {
            for (var ei = 0; ei < trashed.length; ei++) {
                try { await NoteDB.delete(trashed[ei].id); } catch(e) {}
            }
            $("#confirm_layer, #confirm_lightbox").hide();
            renderTrashPanel();
            list_of_drafts();
        });
    });


    //-----------------------------------------------------------------------------------------------
    // Sidebar right-click context menu:
    var ctx_target_id = null;
    $('#sidebar-tabs-list').on('contextmenu', '.sidebar-tab', function(e) {
        e.preventDefault();
        e.stopPropagation();
        ctx_target_id = $(this).data('id');
        var pinned = JSON.parse(localStorage.getItem('pinned_notes') || '[]');
        $('#ctx-pin-note').text(pinned.indexOf(ctx_target_id) !== -1 ? 'Unpin' : 'Pin');
        var ctxTempIds = JSON.parse(sessionStorage.getItem('temp_note_ids') || '[]');
        $('#ctx-mark-temp').text(ctxTempIds.includes(ctx_target_id) ? 'Make permanent' : 'Mark as temporary');
        var menu = $('#note-ctx-menu');
        var x = e.clientX, y = e.clientY;
        var mw = 160, mh = 100;
        if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 4;
        if (y + mh > window.innerHeight) y = window.innerHeight - mh - 4;
        menu.css({ left: x, top: y }).show();
    });
    $(document).on('click', function(e) {
        if (!$(e.target).closest('#note-ctx-menu').length) $('#note-ctx-menu').hide();
    });
    $('#ctx-pin-note').on('click', function() {
        if (!ctx_target_id) return;
        var pinned = JSON.parse(localStorage.getItem('pinned_notes') || '[]');
        var idx = pinned.indexOf(ctx_target_id);
        if (idx !== -1) pinned.splice(idx, 1); else pinned.push(ctx_target_id);
        localStorage.setItem('pinned_notes', JSON.stringify(pinned));
        $('#note-ctx-menu').hide();
        list_of_drafts();
    });
    $('#ctx-rename-note').on('click', async function() {
        if (!ctx_target_id) return;
        $('#note-ctx-menu').hide();
        var $tab = $('#sidebar-tabs-list .sidebar-tab[data-id="' + ctx_target_id + '"]');
        if (!$tab.length) return;
        var allD;
        try { allD = await NoteDB.getAll(); } catch(e) { return; }
        var draft = allD.find(function(d) { return d.id === ctx_target_id; });
        if (!draft) return;
        var current_name = draft.name || $tab.find('.tab-preview').text();
        var $preview = $tab.find('.tab-preview');
        var $input = $('<input type="text" class="tab-rename-input">').val(current_name);
        $preview.html($input);
        $input.focus().select();
        var committed = false;
        async function commitRename() {
            if (committed) return;
            committed = true;
            var new_name = $input.val().trim();
            if (new_name) {
                draft.name = new_name;
            } else {
                delete draft.name;
            }
            try { await NoteDB.put(draft); } catch(e) {}
            list_of_drafts();
        }
        $input.on('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            if (e.key === 'Escape') { committed = true; list_of_drafts(); }
        });
        $input.on('blur', commitRename);
    });
    $('#ctx-delete-note').on('click', function() {
        if (!ctx_target_id) return;
        $('#note-ctx-menu').hide();
        $('#sidebar-tabs-list .sidebar-tab[data-id="' + ctx_target_id + '"] .tab-delete').trigger('click');
    });
    $('#ctx-mark-temp').on('click', async function() {
        if (!ctx_target_id) return;
        var tempIds = JSON.parse(sessionStorage.getItem('temp_note_ids') || '[]');
        var idx = tempIds.indexOf(ctx_target_id);
        var allD = await NoteDB.getAll();
        var draft = allD.find(function(d) { return d.id === ctx_target_id; });
        if (!draft) { $('#note-ctx-menu').hide(); return; }
        if (idx !== -1) {
            tempIds.splice(idx, 1);
            delete draft.is_temp;
        } else {
            tempIds.push(ctx_target_id);
            draft.is_temp = true;
        }
        sessionStorage.setItem('temp_note_ids', JSON.stringify(tempIds));
        await NoteDB.put(draft);
        $('#note-ctx-menu').hide();
        list_of_drafts();
    });

    //-----------------------------------------------------------------------------------------------
    // Populates the sidebar tab list:
    list_of_drafts();

    async function list_of_drafts() {
        var allDrafts;
        try { allDrafts = await NoteDB.getAll(); } catch(e) { return; }
        $('#sidebar-tabs-list').empty();
        if (!allDrafts || allDrafts.length === 0) return;

        var active = allDrafts.filter(function(d) { return !d.trashed; });
        var trashed = allDrafts.filter(function(d) { return !!d.trashed; });

        var pinned = JSON.parse(localStorage.getItem('pinned_notes') || '[]');
        active.sort(function(a, b) {
            var ap = pinned.indexOf(a.id) !== -1, bp = pinned.indexOf(b.id) !== -1;
            if (ap !== bp) return ap ? -1 : 1;
            return b.timestamp - a.timestamp;
        });
        for (var g = 0; g < active.length; g++) {
            var date = new Date(active[g].timestamp * 1000);
            var formatted_date;
            if ((date.getMonth() + 1) == (new Date().getMonth() + 1)) {
                formatted_date = month_name[date.getMonth()] + ' ' + date.getDate() + ', ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2);
            } else {
                formatted_date = ('0' + (date.getMonth() + 1)).slice(-2) + '.' + ('0' + date.getDate()).slice(-2) + '.' + ('0' + date.getFullYear()).slice(-2);
            }
            var first_line = active[g].value.split('\n').find(function(l) { return l.trim(); }) || '';
            var raw_name = active[g].name || first_line.replace(/^#+\s*/, '').trim();
            var short_value = $('<span></span>').text(raw_name).html().slice(0, 50) || 'Untitled';
            var is_active = (active[g].id === draft_id) ? ' active' : '';
            var is_pinned = pinned.indexOf(active[g].id) !== -1;
            var listTempIds = JSON.parse(sessionStorage.getItem('temp_note_ids') || '[]');
            var is_temp_cls = listTempIds.includes(active[g].id) ? ' temp-note' : '';
            $('#sidebar-tabs-list').append(
                '<div class="sidebar-tab' + is_active + (is_pinned ? ' pinned' : '') + is_temp_cls + '" data-id="' + active[g].id + '">' +
                '<div class="tab-date">' + formatted_date + '</div>' +
                '<div class="tab-preview">' + short_value + '</div>' +
                '<span class="tab-delete" title="Move to Trash">&#215;</span>' +
                '</div>'
            );
        }

        $('#trash-badge').text(trashed.length > 0 ? trashed.length : '').toggle(trashed.length > 0);
    }


    //-----------------------------------------------------------------------------------------------
    // Auto-delete empty drafts older than 24 hours (skips last-modified):
    delete_empty_drafts_24();
    setInterval(delete_empty_drafts_24, 3600000);

    async function delete_empty_drafts_24() {
        var allDrafts;
        try { allDrafts = await NoteDB.getAll(); } catch(e) { return; }
        var lastId = sessionStorage.getItem('last_modified_id');
        var today = new Date();
        if (!allDrafts || allDrafts.length <= 1) return;
        for (var i = 0; i < allDrafts.length; i++) {
            if (allDrafts[i].trashed) continue; // trashed notes are managed separately
            var date = new Date(allDrafts[i].timestamp * 1000);
            var diff = Math.floor((((today - date) / 1000) / 60) / 60);
            if ((allDrafts[i].value === '' || allDrafts[i].value === ' ' || allDrafts[i].value.match(/^\s*$/)) && (allDrafts[i].id != lastId) && diff >= 24) {
                try { await NoteDB.delete(allDrafts[i].id); } catch(e) {}
                allDrafts.splice(i, 1);
                i--;
            }
        }
    }


    //-----------------------------------------------------------------------------------------------
    // Sidebar controls:
    if ($(window).width() > 700 && localStorage.getItem('sidebar_collapsed') === '1') {
        $('#sidebar').addClass('collapsed');
    }
    $('#sidebar-toggle').click(function() {
        if ($(window).width() <= 700) {
            $('#sidebar').toggleClass('open');
        } else {
            if ($('#sidebar').hasClass('collapsed')) {
                $('#sidebar').removeClass('collapsed just-collapsed');
                localStorage.removeItem('sidebar_collapsed');
            } else {
                $('#sidebar').addClass('collapsed just-collapsed');
                localStorage.setItem('sidebar_collapsed', '1');
            }
        }
    });
    $('#sidebar').on('mouseleave', function() {
        $(this).removeClass('just-collapsed');
    });
    $(document).on('click', function(e) {
        if ($(window).width() <= 700 && $('#sidebar').hasClass('open') && !$(e.target).closest('#sidebar').length) {
            $('#sidebar').removeClass('open');
        }
    });
    $('#sidebar-new-btn').click(async function() {
        await delete_current_if_empty();
        draft_id = generate_id();
        editor_updating = true; if (inkEditor) inkEditor.update(''); editor_updating = false;
        $('#printable_text').text('');
        sessionStorage.removeItem('last_modified_id');
        reset_telegraph_box();
        $('#count').hide();
        $('#count #count_chars, #count #count_words').text('');
        $('#limit_notice').hide();
        $('#status_text').hide();
        $('#status_text_by_default').show();
        $('#create_temp_url').hide(); $('#download_note').hide();
        document.title = default_page_title;
        list_of_drafts();
        if ($(window).width() <= 700) { $('#sidebar').removeClass('open'); }
        if (inkEditor) inkEditor.focus();
    });
    $('#settings-delete-all').click(function() {
        $("#confirm_lightbox").html('<div id="confirm_message">Are you sure you want to delete all your drafts?</div><div id="confirm_buttons"><div id="ok">Delete</div><div id="cancel">Cancel</div></div>');
        $("#confirm_layer").show();
        $("#confirm_lightbox").show();
        $("#confirm_layer, #confirm_lightbox #confirm_buttons #cancel").click(function() {
            $("#confirm_layer, #confirm_lightbox").hide();
        });
        $("#confirm_lightbox #confirm_buttons #ok").click(async function() {
            try { await NoteDB.clear(); } catch(e) {}
            sessionStorage.removeItem('last_modified_id');
            draft_id = generate_id();
            editor_updating = true; if (inkEditor) inkEditor.update(''); editor_updating = false;
            $('#printable_text').text('');
            reset_telegraph_box();
            $('#count').hide();
            $('#count #count_chars, #count #count_words').text('');
            $('#limit_notice').hide();
            $('#status_text').hide();
            $('#status_text').text('');
            $('#status_text_by_default').show();
            $('#create_temp_url').hide(); $('#download_note').hide();
            $("#confirm_layer, #confirm_lightbox").hide();
            document.title = default_page_title;
            list_of_drafts();
        });
    });
    $('#create_temp_url #temp_url_nav, #temp_url_box #temp_url_buttons #cancel_url').click(function() {
        $('#temp_url_box').toggle('fast');
        $('#temp_url_box #temp_url_result').hide().html('');
        $('#temp_url_box #another_temp_url').hide();
        $('#temp_url_box #temp_url_buttons').show();
    });
    $('#temp_url_box #another_temp_url #create_another_url').click(function() {
        $('#temp_url_box #temp_url_result').hide().html('');
        $('#temp_url_box #another_temp_url').hide();
        $('#temp_url_box #temp_url_buttons').show();
    });
    $('#show_token_field').click(function() {
        $('#telegraph_token_field').toggle();
    });
    $('#count span').click(function() {
        $("#count span").toggle();
    });

    //-----------------------------------------------------------------------------------------------
    // Settings modal:
    $('#settings-gear').click(function() {
        $('#settings-page').show();
    });
    $('#settings-close').click(function() {
        $('#settings-page').hide();
        $('#import-status').text('');
    });
    $('#export-notes').click(async function() {
        var allDrafts;
        try { allDrafts = await NoteDB.getAll(); } catch(e) { return; }
        var backup = { version: 1, exported: Date.now(), notes: allDrafts, pinned: JSON.parse(localStorage.getItem('pinned_notes') || '[]'), trash_retention: localStorage.getItem('trash_retention') || '30' };
        var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'justnotepad-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
    });
    $('#import-notes-btn').click(function() {
        $('#import-notes-input').val('').trigger('click');
    });
    $('#import-notes-input').on('change', async function() {
        var file = this.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = async function(e) {
            try {
                var data = JSON.parse(e.target.result);
                if (!data.notes || !Array.isArray(data.notes)) throw new Error('Invalid backup file.');
                await NoteDB.putAll(data.notes);
                if (Array.isArray(data.pinned) && data.pinned.length) {
                    var existing = JSON.parse(localStorage.getItem('pinned_notes') || '[]');
                    var merged = existing.concat(data.pinned.filter(function(id) { return existing.indexOf(id) === -1; }));
                    localStorage.setItem('pinned_notes', JSON.stringify(merged));
                }
                if (data.trash_retention !== undefined) {
                    localStorage.setItem('trash_retention', String(data.trash_retention));
                    $('#trash-retention').val(String(data.trash_retention));
                }
                list_of_drafts();
                $('#import-status').text('Imported ' + data.notes.length + ' note(s).');
            } catch(err) {
                $('#import-status').text('Error: ' + (err.message || 'Could not import file.'));
            }
        };
        reader.readAsText(file);
    });

    //-----------------------------------------------------------------------------------------------
    // GitHub Gist Sync settings handlers:
    function updateGistSettingsUI() {
        if (GistSync.isConnected()) {
            $('#gist-not-connected').hide();
            $('#gist-connected').show();
            $('#gist-connect-status').text('');
            $('#gist-toast-card').show();
            $('#toggle-gist-toast').text(localStorage.getItem('gist_toast') === '0' ? 'Off' : 'On');
        } else {
            $('#gist-not-connected').show();
            $('#gist-connected').hide();
            $('#gist-toast-card').hide();
        }
    }
    $('#toggle-gist-toast').on('click', function() {
        var off = localStorage.getItem('gist_toast') === '0';
        if (off) { localStorage.removeItem('gist_toast'); $(this).text('On'); }
        else { localStorage.setItem('gist_toast', '0'); $(this).text('Off'); }
    });
    $('#settings-gear').on('click.gistsync', updateGistSettingsUI);
    async function doGistConnect(pat) {
        $('#gist-connect-btn').prop('disabled', true).text('Connecting\u2026');
        $('#gist-connect-status').text('');
        try {
            await GistSync.connect(pat);
            $('#gist-pat-input').val('');
            updateGistSettingsUI();
        } catch(e) {
            $('#gist-connect-status').text('Error: ' + (e.message || 'Could not connect.'));
        }
        $('#gist-connect-btn').prop('disabled', false).text('Connect');
    }
    function exportBackupNow(allDrafts) {
        var backup = { version: 1, exported: Date.now(), notes: allDrafts, pinned: JSON.parse(localStorage.getItem('pinned_notes') || '[]'), trash_retention: localStorage.getItem('trash_retention') || '30' };
        var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'justnotepad-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click(); URL.revokeObjectURL(url);
    }
    $('#gist-connect-btn').click(async function() {
        var pat = $('#gist-pat-input').val().trim();
        if (!pat) return;
        var activeNotes;
        try { activeNotes = await NoteDB.getActive(); } catch(e) { activeNotes = []; }
        if (activeNotes.length === 0) { doGistConnect(pat); return; }
        // Has notes — offer a backup before connecting
        $("#confirm_lightbox").html(
            '<div style="position:relative;">' +
            '<button id="gist-backup-x" style="position:absolute;top:10px;right:12px;border:none;background:none;font-size:20px;cursor:pointer;color:#ccc;line-height:1;padding:2px;" title="Cancel">&times;</button>' +
            '<div id="confirm_message">Back up your notes before syncing?<br><small style="color:#888;font-weight:normal;">If anything goes wrong on first sync, you\u2019ll have a local copy.</small></div>' +
            '<div id="confirm_buttons"><div id="ok">Export &amp; Connect</div><div id="cancel">Skip</div></div>' +
            '</div>'
        );
        $("#confirm_layer").show();
        $("#confirm_lightbox").show();
        $("#confirm_layer").off('click.gistbackup').on('click.gistbackup', function() {
            $("#confirm_layer, #confirm_lightbox").hide();
        });
        $("#confirm_lightbox #gist-backup-x").off('click.gistbackup').on('click.gistbackup', function() {
            $("#confirm_layer, #confirm_lightbox").hide();
        });
        $("#confirm_lightbox #confirm_buttons #cancel").off('click.gistbackup').on('click.gistbackup', function() {
            $("#confirm_layer, #confirm_lightbox").hide();
            doGistConnect(pat);
        });
        $("#confirm_lightbox #confirm_buttons #ok").off('click.gistbackup').on('click.gistbackup', function() {
            $("#confirm_layer, #confirm_lightbox").hide();
            exportBackupNow(activeNotes);
            doGistConnect(pat);
        });
    });
    $('#gist-disconnect-btn').click(function() {
        $("#confirm_lightbox").html('<div id="confirm_message">Disconnect GitHub Gist sync? Your notes stay on this device but will no longer sync.</div><div id="confirm_buttons"><div id="ok">Disconnect</div><div id="cancel">Cancel</div></div>');
        $("#confirm_layer").show();
        $("#confirm_lightbox").show();
        $("#confirm_layer, #confirm_lightbox #confirm_buttons #cancel").click(function() {
            $("#confirm_layer, #confirm_lightbox").hide();
        });
        $("#confirm_lightbox #confirm_buttons #ok").click(function() {
            $("#confirm_layer, #confirm_lightbox").hide();
            GistSync.disconnect();
            updateGistSettingsUI();
        });
    });
    $('#gist-sync-now-btn').click(async function() {
        $('#gist-sync-now-btn').prop('disabled', true);
        await GistSync.push();
        await GistSync.pull();
        $('#gist-sync-now-btn').prop('disabled', false);
    });
    $('#gist-share-device-btn').click(async function() {
        var pat = localStorage.getItem('gist_pat');
        if (!pat) return;
        var shareUrl = location.origin + location.pathname + '#pat=' + encodeURIComponent(pat);
        $('#pat-share-url').val(shareUrl);
        $('#pat-share-qr').text('Generating QR\u2026');
        $('#pat-share-overlay').show();
        try {
            var qrMod = await import('https://esm.sh/qrcode');
            var QRCode = qrMod.default || qrMod;
            var dataUrl = await QRCode.toDataURL(shareUrl, { errorCorrectionLevel: 'M', width: 180, margin: 1 });
            $('#pat-share-qr').html('<img src="' + dataUrl + '" alt="QR code">');
        } catch(e) {
            $('#pat-share-qr').text('QR unavailable \u2014 use the link above.');
        }
    });
    $('#pat-share-copy').click(function() {
        navigator.clipboard.writeText($('#pat-share-url').val()).then(function() {
            $('#pat-share-copy').text('Copied!');
            setTimeout(function() { $('#pat-share-copy').text('Copy'); }, 2000);
        });
    });
    $('#pat-share-close, #pat-share-overlay').click(function(e) {
        if (e.target === this) $('#pat-share-overlay').hide();
    });
    $('#sync-indicator').click(async function() {
        await GistSync.push();
        await GistSync.pull();
    });

    // Auto-connect via URL fragment: justnotepad.pages.dev/#pat=ghp_xxxxx
    (function() {
        var h = location.hash;
        if (h.startsWith('#pat=') && !GistSync.isConnected()) {
            var pat = decodeURIComponent(h.slice(5));
            history.replaceState(null, '', location.pathname + location.search);
            if (!pat) return;
            var msg = 'A GitHub PAT was found in the URL.<br><br>Connect Gist sync using this token?<br><small style="color:#858585">Only confirm if you created this link yourself.</small>';
            $("#confirm_lightbox").html('<div id="confirm_message" style="font-size:130%">' + msg + '</div><div id="confirm_buttons"><div id="ok">Connect</div><div id="cancel">Cancel</div></div>');
            $("#confirm_layer").show();
            $("#confirm_lightbox").show();
            $("#confirm_layer, #confirm_lightbox #confirm_buttons #cancel").off('click.patfrag').on('click.patfrag', function() {
                $("#confirm_layer, #confirm_lightbox").hide();
            });
            $("#confirm_lightbox #confirm_buttons #ok").off('click.patfrag').on('click.patfrag', function() {
                $("#confirm_layer, #confirm_lightbox").hide();
                doGistConnect(pat);
            });
        }
    })();

    //-----------------------------------------------------------------------------------------------
    // Trash settings:
    $('#trash-retention').val(localStorage.getItem('trash_retention') || '30');
    $('#trash-retention').on('change', function() {
        localStorage.setItem('trash_retention', $(this).val());
        GistSync.schedulePush();
    });
    $('#settings-empty-trash').click(async function() {
        var trashed;
        try { trashed = await NoteDB.getTrashed(); } catch(e) { return; }
        if (!trashed || trashed.length === 0) return;
        var msg = 'Permanently delete ' + trashed.length + ' trashed note' + (trashed.length === 1 ? '' : 's') + '? This cannot be undone.';
        $("#confirm_lightbox").html('<div id="confirm_message">' + msg + '</div><div id="confirm_buttons"><div id="ok">Delete</div><div id="cancel">Cancel</div></div>');
        $("#confirm_layer").show();
        $("#confirm_lightbox").show();
        $("#confirm_layer, #confirm_lightbox #confirm_buttons #cancel").click(function() {
            $("#confirm_layer, #confirm_lightbox").hide();
        });
        $("#confirm_lightbox #confirm_buttons #ok").click(async function() {
            for (var ei = 0; ei < trashed.length; ei++) {
                try { await NoteDB.delete(trashed[ei].id); } catch(e) {}
            }
            $("#confirm_layer, #confirm_lightbox").hide();
            if (typeof renderTrashPanel === 'function' && $('#trash-panel').is(':visible')) renderTrashPanel();
            list_of_drafts();
        });
    });

    //-----------------------------------------------------------------------------------------------
    // Auto-hide bottom bar on scroll:
    (function() {
        var lastST = 0;
        $('#main-content').on('scroll', function() {
            if (localStorage.getItem('bar_autohide') === '0') return;
            var st = $(this).scrollTop();
            if (st > lastST + 4) {
                $('#bottom-bar').addClass('bar-hidden');
            } else if (st < lastST - 4) {
                $('#bottom-bar').removeClass('bar-hidden');
            }
            lastST = Math.max(0, st);
        });
        $('#toggle-bar-autohide').on('click', function() {
            var off = localStorage.getItem('bar_autohide') === '0';
            if (off) {
                localStorage.removeItem('bar_autohide');
                $(this).text('On');
                $('#bottom-bar').removeClass('bar-hidden');
            } else {
                localStorage.setItem('bar_autohide', '0');
                $(this).text('Off');
                $('#bottom-bar').removeClass('bar-hidden');
            }
        });
        if (localStorage.getItem('bar_autohide') === '0') {
            $('#toggle-bar-autohide').text('Off');
        }
    })();

    //-----------------------------------------------------------------------------------------------
    // Telegraph sharing:
    function getTelegraphToken(callback) {
        var custom = $('#telegraph_token').val().trim();
        if (custom) { localStorage.setItem('telegraph_access_token', custom); }
        var token = localStorage.getItem('telegraph_access_token');
        if (token) { callback(null, token); return; }
        $.ajax({
            url: 'https://api.telegra.ph/createAccount',
            data: { short_name: 'JustNotepad', author_name: 'JustNotepad User' },
            dataType: 'json'
        }).done(function(res) {
            if (res.ok) {
                localStorage.setItem('telegraph_access_token', res.result.access_token);
                callback(null, res.result.access_token);
            } else {
                callback(res.error || 'Failed to create account');
            }
        }).fail(function() { callback('Network error'); });
    }
    function domToTelegraphNodes(el) {
        var nodes = [], supported = ['p','h3','h4','blockquote','strong','b','em','i','code','pre','ul','ol','li','br','hr','aside','figcaption','s','u'];
        for (var i = 0; i < el.childNodes.length; i++) {
            var node = el.childNodes[i];
            if (node.nodeType === 3) {
                if (node.textContent) nodes.push(node.textContent);
            } else if (node.nodeType === 1) {
                var tag = node.tagName.toLowerCase();
                if (tag === 'h1' || tag === 'h2') tag = 'h3';
                if (tag === 'h5' || tag === 'h6') tag = 'h4';
                if (supported.indexOf(tag) !== -1) {
                    var obj = { tag: tag };
                    var children = domToTelegraphNodes(node);
                    if (children.length) obj.children = children;
                    nodes.push(obj);
                } else if (tag === 'a') {
                    var aobj = { tag: 'a', attrs: { href: node.getAttribute('href') || '#' } };
                    var achildren = domToTelegraphNodes(node);
                    if (achildren.length) aobj.children = achildren;
                    nodes.push(aobj);
                } else {
                    nodes = nodes.concat(domToTelegraphNodes(node));
                }
            }
        }
        return nodes;
    }
    function extractTitle(md) {
        var line = md.split('\n')[0].replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
        return (line || 'Untitled Note').slice(0, 256);
    }
    function stripTitleLine(md) {
        var lines = md.split('\n');
        lines.shift();
        if (lines.length && lines[0].trim() === '') lines.shift();
        return lines.join('\n');
    }
    $('#create_url').click(function() {
        var content = inkEditor ? inkEditor.getDoc() : '';
        if (!content.trim()) {
            $('#temp_url_box #temp_url_result').html('<div class="error">Nothing to share \u2014 write something first.</div>').show();
            return;
        }
        $('#temp_url_box #temp_url_result').html('Sharing...').show();
        $('#create_url').prop('disabled', true).addClass('preloader_button');
        getTelegraphToken(function(err, token) {
            if (err) {
                $('#temp_url_box #temp_url_result').html('<div class="error">' + err + '</div>').show();
                $('#create_url').prop('disabled', false).removeClass('preloader_button');
                return;
            }
            import('./marked/18.0.0/marked.js').catch(function() { return import('https://esm.sh/marked'); }).then(function(module) {
                var markedFn = module.marked || module.default;
                var body = stripTitleLine(content);
                var html = markedFn.parse ? markedFn.parse(body) : markedFn(body);
                var div = document.createElement('div');
                div.innerHTML = html;
                var nodes = domToTelegraphNodes(div);
                if (!nodes.length) nodes = [{ tag: 'p', children: [' '] }];
                $.ajax({
                    url: 'https://api.telegra.ph/createPage',
                    method: 'POST',
                    data: { access_token: token, title: extractTitle(content), content: JSON.stringify(nodes), return_content: false },
                    dataType: 'json'
                }).done(function(res) {
                    if (res.ok) {
                        var url = res.result.url;
                        $('#temp_url_box #temp_url_result').html('<input type="text" id="temp_url" value="' + url + '" readonly onclick="this.select()" /><button id="copy_url" type="button">Copy</button>').show();
                        if (navigator.clipboard) { navigator.clipboard.writeText(url).catch(function(){}); }
                        $('#copy_url').click(function() {
                            if (navigator.clipboard) {
                                navigator.clipboard.writeText(url).then(function() { $('#copy_url').text('Copied!'); setTimeout(function(){ $('#copy_url').text('Copy'); }, 2000); });
                            } else {
                                document.getElementById('temp_url').select(); document.execCommand('copy');
                                $('#copy_url').text('Copied!'); setTimeout(function(){ $('#copy_url').text('Copy'); }, 2000);
                            }
                        });
                        $('#temp_url_box #temp_url_buttons').hide();
                        $('#temp_url_box #another_temp_url').show();
                    } else {
                        $('#temp_url_box #temp_url_result').html('<div class="error">Telegraph: ' + (res.error || 'Unknown error') + '</div>').show();
                    }
                }).fail(function() {
                    $('#temp_url_box #temp_url_result').html('<div class="error">Network error. Try again.</div>').show();
                }).always(function() {
                    $('#create_url').prop('disabled', false).removeClass('preloader_button');
                });
            }).catch(function() {
                $('#temp_url_box #temp_url_result').html('<div class="error">Failed to load markdown parser.</div>').show();
                $('#create_url').prop('disabled', false).removeClass('preloader_button');
            });
        });
    });
    document.addEventListener('gistsync:updated', function() { list_of_drafts(); });

    // If remote sync trashes the currently-open note, switch to most recent active:
    document.addEventListener('gistsync:note-trashed', async function(e) {
        list_of_drafts();
        if (e.detail.id !== draft_id) return;
        var remaining;
        try { remaining = await NoteDB.getActive(); } catch(er) { remaining = []; }
        if (remaining && remaining.length > 0) {
            remaining.sort(function(a,b){return b.timestamp-a.timestamp;});
            draft_id = remaining[0].id;
            var tv = remaining[0].value;
            var tdt = new Date(remaining[0].timestamp * 1000);
            editor_updating = true; if (inkEditor) inkEditor.update(tv); editor_updating = false;
            if (tv.length < 10000) { $('#printable_text').text(tv); } else { $('#printable_text').html(save_the_world_message); }
            count_value(tv);
            $('#count').show();
            $('#status_text').html('Saved in your browser storage as draft on ' + month_name[tdt.getMonth()] + '&nbsp;' + tdt.getDate() + ', ' + tdt.getFullYear() + ', at ' + ('0' + tdt.getHours()).slice(-2) + ':' + ('0' + tdt.getMinutes()).slice(-2) + ':' + ('0' + tdt.getSeconds()).slice(-2));
            $('#status_text_by_default').hide();
            $('#status_text').show();
            reset_telegraph_box();
            $('#create_temp_url').show(); $('#download_note').show();
            sessionStorage.setItem('last_modified_id', draft_id);
        } else {
            draft_id = generate_id();
            editor_updating = true; if (inkEditor) inkEditor.update(''); editor_updating = false;
            $('#printable_text').text('');
            sessionStorage.removeItem('last_modified_id');
            reset_telegraph_box();
            $('#count').hide();
            $('#count #count_chars, #count #count_words').text('');
            $('#status_text').hide();
            $('#status_text_by_default').show();
            $('#create_temp_url').hide(); $('#download_note').hide();
            document.title = default_page_title;
        }
    });

    // Refresh editor if the currently-open note was updated by a pull:
    document.addEventListener('gistsync:note-updated', function(e) {
        if (e.detail.id !== draft_id) return;
        editor_updating = true; if (inkEditor) inkEditor.update(e.detail.value); editor_updating = false;
        var dt = new Date(e.detail.timestamp * 1000);
        $('#status_text').html('Saved in your browser storage as draft on ' + month_name[dt.getMonth()] + '&nbsp;' + dt.getDate() + ', ' + dt.getFullYear() + ', at ' + ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2) + ':' + ('0' + dt.getSeconds()).slice(-2));
        change_page_title(e.detail.value);
        count_value(e.detail.value);
        GistSync.showToast('Note updated from another device');
    });

    // Flush pending push + pull on note switch:
    $('#sidebar-tabs-list').on('click.sync', '.sidebar-tab', function(e) {
        if ($(e.target).hasClass('tab-delete')) return;
        if (GistSync.isConnected()) { GistSync.flushPush(); GistSync.pull(); }
    });

    // Flush pending push + pull when mobile keyboard closes (viewport height increases):
    if (window.visualViewport) {
        var _lastVH = window.visualViewport.height;
        window.visualViewport.addEventListener('resize', function() {
            var newVH = window.visualViewport.height;
            if (newVH > _lastVH + 100 && GistSync.isConnected()) { GistSync.flushPush(); GistSync.pull(); }
            _lastVH = newVH;
        });
    }

    await GistSync.init();
    })(); // end async initApp

    //-----------------------------------------------------------------------------------------------
    // Selection formatting toolbar:
    (function() {
        var editorBox = document.getElementById('editable_text_box');
        var savedSel = null;
        function updateSelToolbar() {
            var sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.toString().trim() || !editorBox || !editorBox.contains(sel.anchorNode)) {
                $('#sel-toolbar').hide();
                return;
            }
            // Snapshot the ink-mde selection while editor still has focus
            savedSel = inkEditor ? inkEditor.selections().pop() : null;
            var rect = sel.getRangeAt(0).getBoundingClientRect();
            var $t = $('#sel-toolbar').show();
            var tw = $t.outerWidth();
            var x = rect.left + rect.width / 2 - tw / 2;
            var y = rect.top - $t.outerHeight() - 8;
            x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
            if (y < 8) y = rect.bottom + 8;
            $t.css({ left: x, top: y });
        }
        document.addEventListener('mouseup', updateSelToolbar);
        document.addEventListener('keyup', updateSelToolbar);
        $(document).on('mousedown', function(e) {
            if (!$(e.target).closest('#sel-toolbar').length) { $('#sel-toolbar').hide(); savedSel = null; }
        });
        $('#sel-toolbar').on('mousedown', '.sel-btn', function(e) {
            e.preventDefault();
            var fmt = $(this).data('fmt');
            if (!inkEditor) return;
            if (fmt === 'strikethrough') {
                inkEditor.wrap({ before: '~~', after: '~~', selection: savedSel });
            } else {
                inkEditor.format(fmt, { selection: savedSel });
            }
            $('#sel-toolbar').hide();
            savedSel = null;
        });
    })();
});
