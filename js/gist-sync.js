window.GistSync = (function() {
    var API = 'https://api.github.com';
    var GIST_DESC = 'justnotepad-sync';
    var _pat = null, _gistId = null, _pullInterval = null, _pushTimer = null;
    var _pushing = false, _pulling = false, _visHandler = null;
    var _retryCount = 0, _retryTimer = null;

    function getSyncedMap() {
        try { return JSON.parse(localStorage.getItem('gist_synced_map') || '{}'); } catch(e) { return {}; }
    }
    function setSyncedMap(map) {
        localStorage.setItem('gist_synced_map', JSON.stringify(map));
    }
    function genId() {
        var s = '', h = '0123456789abcdef';
        for (var i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
        return s;
    }

    function hdrs(pat) {
        return { 'Authorization': 'token ' + (pat || _pat), 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' };
    }

    // Exponential backoff: 15s → 30s → 60s → … → cap 5min
    function scheduleRetry(fn) {
        clearTimeout(_retryTimer);
        var delay = Math.min(15000 * Math.pow(2, _retryCount), 300000);
        _retryCount++;
        _retryTimer = setTimeout(fn, delay);
    }

    async function findOrCreateGist(pat) {
        var page = 1;
        while (true) {
            var res = await fetch(API + '/gists?per_page=100&page=' + page, { headers: hdrs(pat) });
            if (!res.ok) { var err = await res.json().catch(function(){return{};}); throw new Error(err.message || 'GitHub API error ' + res.status); }
            var gists = await res.json();
            for (var i = 0; i < gists.length; i++) {
                if (gists[i].description === GIST_DESC) return gists[i].id;
            }
            if (gists.length < 100) break;
            page++;
        }
        var body = JSON.stringify({ description: GIST_DESC, public: false, files: { '_meta.json': { content: JSON.stringify({ version: 1, notes: [], pinned: [] }) } } });
        var res2 = await fetch(API + '/gists', { method: 'POST', headers: hdrs(pat), body: body });
        if (!res2.ok) { var err2 = await res2.json().catch(function(){return{};}); throw new Error(err2.message || 'Failed to create gist: ' + res2.status); }
        return (await res2.json()).id;
    }

    function setStatus(state) {
        var $el = $('#sync-indicator');
        $el.removeClass('sync-spinning sync-ok sync-error');
        if (state === 'spinning') { $el.show().addClass('sync-spinning').attr('title', 'Syncing\u2026'); }
        else if (state === 'ok')  { $el.show().addClass('sync-ok').attr('title', 'Synced \u2014 click to sync now'); }
        else if (state === 'error'){ $el.show().addClass('sync-error').attr('title', 'Sync error \u2014 click to retry'); }
        else if (state === 'hidden'){ $el.hide(); }
        if (state === 'hidden') { $('body').removeClass('sync-active'); }
        else { $('body').addClass('sync-active'); }
    }

    async function push() {
        if (!_pat || !_gistId || _pushing) return;
        if (!navigator.onLine) return; // offline — will sync on reconnect
        _pushing = true;
        setStatus('spinning');
        try {
            // Fetch remote meta first so we don't wipe notes from other devices
            var remoteMeta = { version: 1, notes: [], pinned: [] };
            try {
                var rr = await fetch(API + '/gists/' + _gistId, { headers: hdrs() });
                if (rr.ok) {
                    var rg = await rr.json();
                    if (rg.files['_meta.json'] && rg.files['_meta.json'].content) {
                        remoteMeta = JSON.parse(rg.files['_meta.json'].content);
                    }
                }
            } catch(e) { /* proceed with empty remote meta */ }

            var allDrafts = await NoteDB.getAll();
            var files = {};

            // Build tombstone map: local trashed notes + remote tombstones
            var tombstoneMap = {};
            for (var t = 0; t < allDrafts.length; t++) {
                if (allDrafts[t].trashed) tombstoneMap[allDrafts[t].id] = allDrafts[t].deletedAt || Math.round(Date.now() / 1000);
            }
            var remoteTombstones = remoteMeta.deleted || [];
            for (var rt = 0; rt < remoteTombstones.length; rt++) {
                if (!tombstoneMap[remoteTombstones[rt].id]) tombstoneMap[remoteTombstones[rt].id] = remoteTombstones[rt].at;
            }
            var mergedTombstones = Object.keys(tombstoneMap).map(function(id) { return { id: id, at: tombstoneMap[id] }; });

            // Start with remote note entries, then update/add local active ones (skip tombstoned IDs)
            var mergedNotes = {};
            for (var k = 0; k < remoteMeta.notes.length; k++) {
                var rn = remoteMeta.notes[k];
                if (!tombstoneMap[rn.id]) mergedNotes[rn.id] = rn;
            }
            for (var i = 0; i < allDrafts.length; i++) {
                var d = allDrafts[i];
                if (d.trashed) continue; // trashed → tombstone, not active note
                files['note-' + d.id + '.md'] = { content: d.value || ' ' };
                var noteEntry = { id: d.id, timestamp: d.timestamp };
                if (d.name) noteEntry.name = d.name;
                mergedNotes[d.id] = noteEntry;
            }

            // Merge pinned arrays
            var localPinned = JSON.parse(localStorage.getItem('pinned_notes') || '[]');
            var remotePinned = remoteMeta.pinned || [];
            var mergedPinned = localPinned.concat(remotePinned.filter(function(id) { return localPinned.indexOf(id) === -1; }));

            var notesList = Object.keys(mergedNotes).map(function(id) { return mergedNotes[id]; });
            var localRetention = parseInt(localStorage.getItem('trash_retention') || '30', 10);
            files['_meta.json'] = { content: JSON.stringify({ version: 1, notes: notesList, pinned: mergedPinned, deleted: mergedTombstones, trash_retention: localRetention }) };

            var res = await fetch(API + '/gists/' + _gistId, { method: 'PATCH', headers: hdrs(), body: JSON.stringify({ files: files }) });
            if (!res.ok) throw new Error('Push failed: ' + res.status);
            // Invalidate cached ETag since we just modified the gist
            localStorage.removeItem('gist_etag');
            localStorage.setItem('gist_last_synced_at', new Date().toISOString());
            _retryCount = 0;
            setStatus('ok');
        } catch(e) { console.error('GistSync push:', e); setStatus('error'); scheduleRetry(push); }
        _pushing = false;
    }

    async function pull() {
        if (!_pat || !_gistId || _pulling) return;
        if (!navigator.onLine) return; // offline — will sync on reconnect
        _pulling = true;
        if (!_pushing) setStatus('spinning');
        try {
            // Use ETag to skip processing when nothing has changed
            var pullHdrs = hdrs();
            var storedEtag = localStorage.getItem('gist_etag');
            if (storedEtag) pullHdrs['If-None-Match'] = storedEtag;

            var res = await fetch(API + '/gists/' + _gistId, { headers: pullHdrs });

            if (res.status === 304) {
                // Gist unchanged since last pull — nothing to do
                _retryCount = 0;
                if (!_pushing) setStatus('ok');
                _pulling = false;
                return;
            }

            if (!res.ok) throw new Error('Pull failed: ' + res.status);

            // Store new ETag for next pull
            var newEtag = res.headers.get('ETag');
            if (newEtag) localStorage.setItem('gist_etag', newEtag);

            var gist = await res.json();
            var files = gist.files;
            var meta = { version: 1, notes: [], pinned: [] };
            if (files['_meta.json'] && files['_meta.json'].content) {
                try { meta = JSON.parse(files['_meta.json'].content); } catch(e) {}
            }
            var localDrafts = await NoteDB.getAll();
            var localMap = {};
            for (var i = 0; i < localDrafts.length; i++) { localMap[localDrafts[i].id] = localDrafts[i]; }
            var changedCount = 0;
            var conflictCount = 0;
            var syncedMap = getSyncedMap();
            for (var j = 0; j < meta.notes.length; j++) {
                var mn = meta.notes[j];
                var fname = 'note-' + mn.id + '.md';
                if (!files[fname]) continue;
                var remoteContent = files[fname].content || '';
                var remoteTs = mn.timestamp || 0;
                var local = localMap[mn.id];
                if (local && local.trashed) continue; // locally trashed — don't overwrite with remote active
                var lastSyncedTs = syncedMap[mn.id] || 0;
                var isConflict = local
                    && remoteTs > lastSyncedTs
                    && local.timestamp > lastSyncedTs
                    && local.value !== remoteContent;
                if (isConflict) {
                    var origName = local.name || (local.value || '').split('\n')[0].trim().slice(0, 40) || 'Note';
                    await NoteDB.put({ id: genId(), timestamp: local.timestamp, value: local.value, name: origName + ' (sync conflict)' });
                    conflictCount++;
                }
                if (!local || remoteTs > local.timestamp) {
                    var putObj = { id: mn.id, timestamp: remoteTs, value: remoteContent };
                    if (mn.name) putObj.name = mn.name;
                    await NoteDB.put(putObj);
                    changedCount++;
                    document.dispatchEvent(new CustomEvent('gistsync:note-updated', { detail: { id: mn.id, value: remoteContent, timestamp: remoteTs } }));
                }
                syncedMap[mn.id] = remoteTs;
            }
            // Apply remote tombstones: if tombstone is newer than local note → trash locally
            var remoteTombstoneList = meta.deleted || [];
            for (var tk = 0; tk < remoteTombstoneList.length; tk++) {
                var tomb = remoteTombstoneList[tk];
                var localNote = localMap[tomb.id];
                if (localNote && !localNote.trashed && tomb.at > (localNote.timestamp || 0)) {
                    await NoteDB.trash(tomb.id);
                    changedCount++;
                    document.dispatchEvent(new CustomEvent('gistsync:note-trashed', { detail: { id: tomb.id } }));
                }
            }
            setSyncedMap(syncedMap);

            if (meta.pinned && meta.pinned.length) {
                var ep = JSON.parse(localStorage.getItem('pinned_notes') || '[]');
                var mp = ep.concat(meta.pinned.filter(function(id) { return ep.indexOf(id) === -1; }));
                localStorage.setItem('pinned_notes', JSON.stringify(mp));
            }
            if (meta.trash_retention !== undefined) {
                localStorage.setItem('trash_retention', String(meta.trash_retention));
                $('#trash-retention').val(String(meta.trash_retention));
            }
            if (conflictCount > 0) {
                document.dispatchEvent(new Event('gistsync:updated'));
                schedulePush();
                showConflictToast(conflictCount);
            } else if (changedCount > 0) {
                document.dispatchEvent(new Event('gistsync:updated'));
                showToast(changedCount === 1 ? '1 note synced' : changedCount + ' notes synced');
            }
            localStorage.setItem('gist_last_synced_at', new Date().toISOString());
            _retryCount = 0;
            if (!_pushing) setStatus('ok');
        } catch(e) { console.error('GistSync pull:', e); if (!_pushing) setStatus('error'); scheduleRetry(pull); }
        _pulling = false;
    }

    var _toastTimer = null;
    function showConflictToast(n) {
        var msg = n === 1 ? 'Sync conflict \u2014 a copy was saved' : n + ' sync conflicts \u2014 copies saved';
        var $t = $('#sync-toast');
        $t.text(msg).stop(true).fadeIn(200);
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(function() { $t.fadeOut(400); }, 5000);
    }
    function showToast(msg) {
        if (localStorage.getItem('gist_toast') === '0') return;
        var $t = $('#sync-toast');
        $t.text(msg).stop(true).fadeIn(200);
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(function() { $t.fadeOut(400); }, 3000);
    }

    function schedulePush() {
        clearTimeout(_pushTimer);
        _pushTimer = setTimeout(push, 15000);
    }

    function flushPush() {
        if (!_pushTimer) return;
        clearTimeout(_pushTimer);
        _pushTimer = null;
        push();
    }

    function _onlineHandler() { pull(); }

    function startPolling() {
        _visHandler = function() { if (document.visibilityState === 'visible') pull(); };
        document.addEventListener('visibilitychange', _visHandler);
        window.addEventListener('online', _onlineHandler);
        _pullInterval = setInterval(pull, 60000);
    }

    function stopPolling() {
        if (_visHandler) { document.removeEventListener('visibilitychange', _visHandler); _visHandler = null; }
        window.removeEventListener('online', _onlineHandler);
        if (_pullInterval) { clearInterval(_pullInterval); _pullInterval = null; }
    }

    async function connect(pat) {
        var gistId = await findOrCreateGist(pat);
        _pat = pat; _gistId = gistId;
        localStorage.setItem('gist_pat', pat);
        localStorage.setItem('gist_id', gistId);
        setStatus('ok');
        await push();
        await pull();
        startPolling();
    }

    function disconnect() {
        _pat = null; _gistId = null;
        clearTimeout(_pushTimer);
        clearTimeout(_retryTimer);
        _retryCount = 0;
        stopPolling();
        localStorage.removeItem('gist_pat');
        localStorage.removeItem('gist_id');
        localStorage.removeItem('gist_last_synced_at');
        localStorage.removeItem('gist_synced_map');
        localStorage.removeItem('gist_etag');
        setStatus('hidden');
    }

    async function init() {
        var pat = localStorage.getItem('gist_pat');
        var gistId = localStorage.getItem('gist_id');
        if (!pat || !gistId) return;
        _pat = pat; _gistId = gistId;
        setStatus('ok');
        startPolling();
        await pull();
    }

    return {
        init: init, connect: connect, disconnect: disconnect,
        push: push, pull: pull, schedulePush: schedulePush, flushPush: flushPush, setStatus: setStatus,
        showToast: showToast,
        isConnected: function() { return !!_pat; }
    };
})();
