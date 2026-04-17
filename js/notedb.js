(function() {
    var DB_NAME = 'justnotepad', STORE = 'drafts', DB_VER = 1, _db = null;

    function openDB() {
        return new Promise(function(resolve, reject) {
            if (_db) { resolve(_db); return; }
            var req = indexedDB.open(DB_NAME, DB_VER);
            req.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = function(e) { _db = e.target.result; resolve(_db); };
            req.onerror   = function(e) { reject(e.target.error); };
        });
    }

    window.NoteDB = {
        open: function() { return openDB(); },

        getAll: function() {
            return openDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
                    req.onsuccess = function()  { resolve(req.result); };
                    req.onerror   = function(e) { reject(e.target.error); };
                });
            });
        },

        put: function(draft) {
            return openDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(draft);
                    req.onsuccess = function()  { resolve(); };
                    req.onerror   = function(e) { reject(e.target.error); };
                });
            });
        },

        delete: function(id) {
            return openDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
                    req.onsuccess = function()  { resolve(); };
                    req.onerror   = function(e) { reject(e.target.error); };
                });
            });
        },

        clear: function() {
            return openDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
                    req.onsuccess = function()  { resolve(); };
                    req.onerror   = function(e) { reject(e.target.error); };
                });
            });
        },

        putAll: function(draftsArray) {
            return openDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx = db.transaction(STORE, 'readwrite');
                    var store = tx.objectStore(STORE);
                    var i = 0;
                    function next() {
                        if (i >= draftsArray.length) { resolve(); return; }
                        var req = store.put(draftsArray[i++]);
                        req.onsuccess = next;
                        req.onerror   = function(e) { reject(e.target.error); };
                    }
                    next();
                });
            });
        },

        trash: function(id) {
            return openDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx = db.transaction(STORE, 'readwrite');
                    var store = tx.objectStore(STORE);
                    var req = store.get(id);
                    req.onsuccess = function() {
                        var draft = req.result;
                        if (!draft) { resolve(); return; }
                        draft.trashed = true;
                        draft.deletedAt = Math.round(Date.now() / 1000);
                        var req2 = store.put(draft);
                        req2.onsuccess = function() { resolve(); };
                        req2.onerror   = function(e) { reject(e.target.error); };
                    };
                    req.onerror = function(e) { reject(e.target.error); };
                });
            });
        },

        untrash: function(id) {
            return openDB().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx = db.transaction(STORE, 'readwrite');
                    var store = tx.objectStore(STORE);
                    var req = store.get(id);
                    req.onsuccess = function() {
                        var draft = req.result;
                        if (!draft) { resolve(); return; }
                        delete draft.trashed;
                        delete draft.deletedAt;
                        var req2 = store.put(draft);
                        req2.onsuccess = function() { resolve(); };
                        req2.onerror   = function(e) { reject(e.target.error); };
                    };
                    req.onerror = function(e) { reject(e.target.error); };
                });
            });
        },

        getActive: function() {
            return this.getAll().then(function(drafts) {
                return drafts.filter(function(d) { return !d.trashed; });
            });
        },

        getTrashed: function() {
            return this.getAll().then(function(drafts) {
                return drafts.filter(function(d) { return !!d.trashed; });
            });
        }
    };
})();
