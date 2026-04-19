window.GistSync = (function() {
    var API = 'https://api.github.com';
    var GIST_DESC = 'justnotepad-sync';
    var _pat = null, _gistId = null, _pullInterval = null, _pushTimer = null;
    var _pushing = false, _pulling = false, _visHandler = null;
    var _retryCount = 0, _retryTimer = null;

    // Multi-tab leader election via BroadcastChannel.
    // Strategy: start as optimistic leader; resign if an older tab replies.
    var _tabId = genId();
    var _born  = Date.now();
    var _channel = null;
    var _peers = {};               // { tabId: { born, lastSeen } }
    var _isLeader = false;
    var _heartbeatTimer = null;
    var _leaderCheckTimer = null;

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

    // ── Leader election ──────────────────────────────────────────────────────

    function becomeLeader() {
        if (_isLeader) return; // already leading
        _isLeader = true;
        clearInterval(_leaderCheckTimer);
        _heartbeatTimer = setInterval(function() {
            if (_channel) _channel.postMessage({ type: 'heartbeat', tabId: _tabId });
        }, 10000);
        startPolling();
        pull(); // immediate pull on stepping up
    }

    function resignLeader() {
        _isLeader = false;
        clearInterval(_heartbeatTimer);
        _heartbeatTimer = null;
        stopPolling();
        // Watch for dead leader so we can step up if needed
        _leaderCheckTimer = setInterval(checkLeaderAlive, 15000);
    }

    function checkLeaderAlive() {
        var peerIds = Object.keys(_peers);
        if (!peerIds.length) {
            clearInterval(_leaderCheckTimer);
            becomeLeader();
            return;
        }
        // Find the peer with the smallest born timestamp (the current leader)
        var leaderId = null, minBorn = Infinity;
        peerIds.forEach(function(id) {
            if (_peers[id].born < minBorn) { minBorn = _peers[id].born; leaderId = id; }
        });
        if (!leaderId || minBorn >= _born) {
            // We're older than all known peers — step up
            clearInterval(_leaderCheckTimer);
            becomeLeader();
            return;
        }
        if (Date.now() - _peers[leaderId].lastSeen > 20000) {
            // Leader went silent — remove it and see if we should lead
            delete _peers[leaderId];
            clearInterval(_leaderCheckTimer);
            var remaining = Object.keys(_peers);
            var weAreOldest = remaining.every(function(id) { return _peers[id].born > _born; });
            if (weAreOldest) {
                becomeLeader();
            } else {
                _leaderCheckTimer = setInterval(checkLeaderAlive, 15000);
            }
        }
    }

    function initChannel() {
        if (!window.BroadcastChannel) return;
        _channel = new BroadcastChannel('justnotepad-sync');

        _channel.onmessage = function(e) {
            var msg = e.data;
            var id = msg.tabId;
            switch (msg.type) {
                case 'announce':
                    if (!id) break;
                    _peers[id] = { born: msg.born, lastSeen: Date.now() };
                    _channel.postMessage({ type: 'announce-reply', tabId: _tabId, born: _born });
                    // If they are older than us and we're currently leader, resign
                    if (_isLeader && msg.born < _born) resignLeader();
                    break;
                case 'announce-reply':
                    if (!id) break;
                    _peers[id] = { born: msg.born, lastSeen: Date.now() };
                    if (_isLeader && msg.born < _born) resignLeader();
                    break;
                case 'heartbeat':
                    if (id && _peers[id]) _peers[id].lastSeen = Date.now();
                    break;
                case 'close':
                    if (!id) break;
                    var closedBorn = _peers[id] ? _peers[id].born : Infinity;
                    delete _peers[id];
                    // If the closing tab was the leader and we're a follower, re-check
                    if (!_isLeader && closedBorn < _born) {
                        clearInterval(_leaderCheckTimer);
                        var remaining = Object.keys(_peers);
                        var weAreOldest = remaining.every(function(rid) { return _peers[rid].born > _born; });
                        if (weAreOldest) becomeLeader();
                        else _leaderCheckTimer = setInterval(checkLeaderAlive, 15000);
                    }
                    break;
                case 'push-needed':
                    if (_isLeader) schedulePushInternal();
                    break;
                case 'flush-push':
                    if (_isLeader) flushPushInternal();
                    break;
                case 'pull-please':
                    if (_isLeader) pull();
                    break;
                case 'pull-result':
                    if (!_isLeader) applyBroadcastResult(msg);
                    break;
            }
        };

        // Start as optimistic leader immediately — older peers will correct us
        becomeLeader();
        _channel.postMessage({ type: 'announce', tabId: _tabId, born: _born });

        window.addEventListener('beforeunload', function() {
            if (_channel) _channel.postMessage({ type: 'close', tabId: _tabId });
        });
    }

    // Broadcast what changed to follower tabs after a real pull
    function broadcastPullResult(changedNotes, trashedIds, meta, syncedMap) {
        if (!_channel) return;
        _channel.postMessage({
            type: 'pull-result',
            notes: changedNotes,
            trashed: trashedIds,
            pinned: meta.pinned || [],
            trash_retention: meta.trash_retention,
            syncedMap: syncedMap,
            last_synced_at: localStorage.getItem('gist_last_synced_at')
        });
    }

    // Follower tabs apply a broadcasted pull result to their local DB + UI
    async function applyBroadcastResult(data) {
        var syncedMap = getSyncedMap();
        var anyChange = false;
        for (var i = 0; i < (data.notes || []).length; i++) {
            var n = data.notes[i];
            await NoteDB.put(n);
            syncedMap[n.id] = n.timestamp;
            document.dispatchEvent(new CustomEvent('gistsync:note-updated', { detail: { id: n.id, value: n.value, timestamp: n.timestamp } }));
            anyChange = true;
        }
        for (var j = 0; j < (data.trashed || []).length; j++) {
            await NoteDB.trash(data.trashed[j]);
            document.dispatchEvent(new CustomEvent('gistsync:note-trashed', { detail: { id: data.trashed[j] } }));
            anyChange = true;
        }
        if (data.syncedMap) {
            Object.keys(data.syncedMap).forEach(function(id) { syncedMap[id] = data.syncedMap[id]; });
        }
        setSyncedMap(syncedMap);
        if (data.pinned && data.pinned.length) {
            var ep = JSON.parse(localStorage.getItem('pinned_notes') || '[]');
            var mp = ep.concat(data.pinned.filter(function(id) { return ep.indexOf(id) === -1; }));
            localStorage.setItem('pinned_notes', JSON.stringify(mp));
        }
        if (data.trash_retention !== undefined) {
            localStorage.setItem('trash_retention', String(data.trash_retention));
            $('#trash-retention').val(String(data.trash_retention));
        }
        if (data.last_synced_at) localStorage.setItem('gist_last_synced_at', data.last_synced_at);
        if (anyChange) document.dispatchEvent(new Event('gistsync:updated'));
        setStatus('ok');
    }

    // ── GitHub API ───────────────────────────────────────────────────────────

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
        if (!navigator.onLine) return;
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
                if (d.trashed) continue;
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
            localStorage.removeItem('gist_etag'); // invalidate ETag — gist just changed
            localStorage.setItem('gist_last_synced_at', new Date().toISOString());
            _retryCount = 0;
            setStatus('ok');
        } catch(e) { console.error('GistSync push:', e); setStatus('error'); scheduleRetry(push); }
        _pushing = false;
    }

    async function pull() {
        if (!_pat || !_gistId || _pulling) return;
        if (!navigator.onLine) return;
        if (_channel && !_isLeader) return; // only the leader polls GitHub
        _pulling = true;
        if (!_pushing) setStatus('spinning');
        try {
            var pullHdrs = hdrs();
            var storedEtag = localStorage.getItem('gist_etag');
            if (storedEtag) pullHdrs['If-None-Match'] = storedEtag;

            var res = await fetch(API + '/gists/' + _gistId, { headers: pullHdrs });

            if (res.status === 304) {
                _retryCount = 0;
                if (!_pushing) setStatus('ok');
                _pulling = false;
                return;
            }

            if (!res.ok) throw new Error('Pull failed: ' + res.status);

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
            var changedNotes = [];
            var trashedIds = [];

            for (var j = 0; j < meta.notes.length; j++) {
                var mn = meta.notes[j];
                var fname = 'note-' + mn.id + '.md';
                if (!files[fname]) continue;
                var remoteContent = files[fname].content || '';
                var remoteTs = mn.timestamp || 0;
                var local = localMap[mn.id];
                if (local && local.trashed) continue;
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
                    changedNotes.push(putObj);
                    document.dispatchEvent(new CustomEvent('gistsync:note-updated', { detail: { id: mn.id, value: remoteContent, timestamp: remoteTs } }));
                }
                syncedMap[mn.id] = remoteTs;
            }

            // Apply remote tombstones
            var remoteTombstoneList = meta.deleted || [];
            for (var tk = 0; tk < remoteTombstoneList.length; tk++) {
                var tomb = remoteTombstoneList[tk];
                var localNote = localMap[tomb.id];
                if (localNote && !localNote.trashed && tomb.at > (localNote.timestamp || 0)) {
                    await NoteDB.trash(tomb.id);
                    changedCount++;
                    trashedIds.push(tomb.id);
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
                schedulePushInternal();
                showConflictToast(conflictCount);
            } else if (changedCount > 0) {
                document.dispatchEvent(new Event('gistsync:updated'));
                showToast(changedCount === 1 ? '1 note synced' : changedCount + ' notes synced');
            }
            localStorage.setItem('gist_last_synced_at', new Date().toISOString());
            _retryCount = 0;
            if (!_pushing) setStatus('ok');

            // Relay changes to follower tabs
            if (changedNotes.length || trashedIds.length) {
                broadcastPullResult(changedNotes, trashedIds, meta, syncedMap);
            }
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

    // Internal versions — always run regardless of leader status
    function schedulePushInternal() {
        clearTimeout(_pushTimer);
        _pushTimer = setTimeout(push, 15000);
    }
    function flushPushInternal() {
        if (!_pushTimer) return;
        clearTimeout(_pushTimer);
        _pushTimer = null;
        push();
    }

    // Public API — follower tabs route through the leader
    function schedulePush() {
        if (_channel && !_isLeader) { _channel.postMessage({ type: 'push-needed' }); return; }
        schedulePushInternal();
    }
    function flushPush() {
        if (_channel && !_isLeader) { _channel.postMessage({ type: 'flush-push' }); return; }
        flushPushInternal();
    }

    function _onlineHandler() { pull(); }

    function startPolling() {
        _visHandler = function() {
            if (document.visibilityState !== 'visible') return;
            if (_isLeader || !_channel) { pull(); }
            else { _channel.postMessage({ type: 'pull-please' }); }
        };
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
        initChannel();
        if (!_channel) { startPolling(); } // fallback if BroadcastChannel unavailable
        await push();
        await pull();
    }

    function disconnect() {
        _pat = null; _gistId = null;
        clearTimeout(_pushTimer);
        clearTimeout(_retryTimer);
        clearInterval(_heartbeatTimer);
        clearInterval(_leaderCheckTimer);
        _retryCount = 0;
        if (_channel) {
            _channel.postMessage({ type: 'close', tabId: _tabId });
            _channel.close();
            _channel = null;
        }
        _isLeader = false;
        _peers = {};
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
        initChannel();
        if (!_channel) { startPolling(); } // fallback if BroadcastChannel unavailable
        await pull();
    }

    return {
        init: init, connect: connect, disconnect: disconnect,
        push: push, pull: pull, schedulePush: schedulePush, flushPush: flushPush, setStatus: setStatus,
        showToast: showToast,
        isConnected: function() { return !!_pat; }
    };
})();
