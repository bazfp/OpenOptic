// usbspy: logs every USB transfer an app makes through macOS IOUSBLib, so we can read what a working
// scanner program (e.g. The free trial software) sends to our own hardware. Loaded with DYLD_INSERT_LIBRARIES; the app is
// not modified. Output: one text line per call in $USBSPY_LOG (default ./usbspy_<pid>.log).
//   Bulk IN payloads are logged in full when the announced transfer is <= 4 MB (calibration frames), else only
//   length + first 32 bytes. USBSPY_FULL=1 logs every payload in full.
// Build: see build.sh. Only the first USB device interface vtable layout (v100) is relied on by name;
// every other slot is logged generically by index, so nothing the app calls goes unseen.
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>
#include <stdarg.h>

#define NSLOT 96
#define SLOT(T, f) ((int)(offsetof(T, f) / sizeof(void *)))

enum { KDEV = 0, KINTF = 1 };
typedef struct { void **vtbl; void **real; int kind; } W; // vtbl must stay first: it is what `self` points at

static FILE *spylog;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static struct timespec t0;
static int full;
static unsigned cur_in_size; // bytes announced by the last 0x82 (bulk IN) header; small frames are logged in full
#define FULL_LIMIT (4u << 20)

static void logline(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void logline(const char *fmt, ...) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    double s = (t.tv_sec - t0.tv_sec) + (t.tv_nsec - t0.tv_nsec) / 1e9;
    pthread_mutex_lock(&mu);
    fprintf(spylog, "%.6f ", s);
    va_list ap; va_start(ap, fmt); vfprintf(spylog, fmt, ap); va_end(ap);
    fputc('\n', spylog); fflush(spylog);
    pthread_mutex_unlock(&mu);
}
// log "prefix ... data=<hex>" in one line
static void logdata(const char *head, const unsigned char *p, size_t n) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    double s = (t.tv_sec - t0.tv_sec) + (t.tv_nsec - t0.tv_nsec) / 1e9;
    pthread_mutex_lock(&mu);
    fprintf(spylog, "%.6f %s data=", s, head);
    for (size_t i = 0; i < n; i++) fprintf(spylog, "%02x", p[i]);
    fputc('\n', spylog); fflush(spylog);
    pthread_mutex_unlock(&mu);
}

static void **origv[2][NSLOT]; // original vtable contents per kind (first object of each kind seen)
static int have[2];

typedef uintptr_t (*fn8)(uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t);
static inline fn8 orig(W *w, int slot) { return (fn8)origv[w->kind][slot]; }

// ---- endpoint lookup ----
static int pipe_ep(W *w, UInt8 pipe) {
    UInt8 dir = 0, num = 0, type = 0, interval = 0; UInt16 mps = 0;
    IOUSBInterfaceInterface **r = (IOUSBInterfaceInterface **)w->real;
    if ((*r)->GetPipeProperties(r, pipe, &dir, &num, &type, &mps, &interval)) return -1;
    return num | (dir == kUSBIn ? 0x80 : 0); // kUSBIn=1
}

// ---- specific hooks ----
static IOReturn h_devreq2(void *self, UInt8 pipe, int has_pipe, IOUSBDevRequest *rq, int slot, const char *tag) {
    W *w = self; int in = rq->bmRequestType & 0x80;
    char head[160];
    if (!in && rq->wLength) {
        snprintf(head, sizeof head, "%s rt=%02x req=%02x val=%04x idx=%04x len=%u OUT", tag, rq->bmRequestType, rq->bRequest, rq->wValue, rq->wIndex, rq->wLength);
        logdata(head, rq->pData, rq->wLength);
        if (rq->bmRequestType == 0x40 && rq->bRequest == 4 && rq->wValue == 0x82 && rq->wIndex == 0 && rq->wLength >= 8)
            memcpy(&cur_in_size, (unsigned char *)rq->pData + 4, 4); // little-endian host
    }
    IOReturn r = has_pipe ? (IOReturn)orig(w, slot)((uintptr_t)w->real, pipe, (uintptr_t)rq, 0, 0, 0, 0, 0)
                          : (IOReturn)orig(w, slot)((uintptr_t)w->real, (uintptr_t)rq, 0, 0, 0, 0, 0, 0);
    if (in) {
        snprintf(head, sizeof head, "%s rt=%02x req=%02x val=%04x idx=%04x len=%u IN ret=%08x got=%u", tag, rq->bmRequestType, rq->bRequest, rq->wValue, rq->wIndex, rq->wLength, r, rq->wLenDone);
        logdata(head, rq->pData, r ? 0 : rq->wLenDone);
    } else logline("%s result ret=%08x", tag, r);
    return r;
}
static IOReturn h_devreq(void *self, IOUSBDevRequest *rq, int slot, const char *tag) { return h_devreq2(self, 0, 0, rq, slot, tag); }
#define DEVREQ(name, field, tag) \
    static IOReturn name(void *self, IOUSBDevRequest *rq) { return h_devreq(self, rq, SLOT(IOUSBDeviceInterface, field), tag); }
DEVREQ(h_DeviceRequest, DeviceRequest, "CTRL")
static IOReturn h_DeviceRequestTO(void *self, IOUSBDevRequestTO *rq) {
    return h_devreq(self, (IOUSBDevRequest *)rq, SLOT(IOUSBDeviceInterface, DeviceRequestTO), "CTRL");
}

static IOReturn h_ControlRequest(void *self, UInt8 pipe, IOUSBDevRequest *rq) {
    return h_devreq2(self, pipe, 1, rq, SLOT(IOUSBInterfaceInterface, ControlRequest), "CTRL");
}
static IOReturn h_ControlRequestTO(void *self, UInt8 pipe, IOUSBDevRequestTO *rq) {
    return h_devreq2(self, pipe, 1, (IOUSBDevRequest *)rq, SLOT(IOUSBInterfaceInterface182, ControlRequestTO), "CTRL");
}

static void log_out(W *w, int slot, UInt8 pipe, void *buf, UInt32 n, const char *tag) {
    char head[96]; snprintf(head, sizeof head, "%s ep=%02x len=%u", tag, pipe_ep(w, pipe) & 0xff, n);
    logdata(head, buf, n);
    (void)slot;
}
static void log_in(W *w, UInt8 pipe, void *buf, UInt32 n, IOReturn r, const char *tag) {
    char head[96]; snprintf(head, sizeof head, "%s ep=%02x ret=%08x got=%u", tag, pipe_ep(w, pipe) & 0xff, r, n);
    logdata(head, buf, r ? 0 : (full || cur_in_size <= FULL_LIMIT ? n : (n < 32 ? n : 32)));
}

static IOReturn h_ReadPipe(void *self, UInt8 pipe, void *buf, UInt32 *size) {
    W *w = self; UInt32 want = *size;
    IOReturn r = (IOReturn)orig(w, SLOT(IOUSBInterfaceInterface, ReadPipe))((uintptr_t)w->real, pipe, (uintptr_t)buf, (uintptr_t)size, 0, 0, 0, 0);
    (void)want; log_in(w, pipe, buf, *size, r, "BULKIN"); return r;
}
static IOReturn h_ReadPipeTO(void *self, UInt8 pipe, void *buf, UInt32 *size, UInt32 nd, UInt32 cp) {
    W *w = self;
    IOReturn r = (IOReturn)orig(w, SLOT(IOUSBInterfaceInterface, ReadPipeTO))((uintptr_t)w->real, pipe, (uintptr_t)buf, (uintptr_t)size, nd, cp, 0, 0);
    log_in(w, pipe, buf, *size, r, "BULKIN"); return r;
}
static IOReturn h_WritePipe(void *self, UInt8 pipe, void *buf, UInt32 size) {
    W *w = self; log_out(w, 0, pipe, buf, size, "BULKOUT");
    return (IOReturn)orig(w, SLOT(IOUSBInterfaceInterface, WritePipe))((uintptr_t)w->real, pipe, (uintptr_t)buf, size, 0, 0, 0, 0);
}
static IOReturn h_WritePipeTO(void *self, UInt8 pipe, void *buf, UInt32 size, UInt32 nd, UInt32 cp) {
    W *w = self; log_out(w, 0, pipe, buf, size, "BULKOUT");
    return (IOReturn)orig(w, SLOT(IOUSBInterfaceInterface, WritePipeTO))((uintptr_t)w->real, pipe, (uintptr_t)buf, size, nd, cp, 0, 0);
}

// async: wrap the completion callback so results are logged too
typedef struct { IOAsyncCallback1 cb; void *refcon; W *w; UInt8 pipe; void *buf; int in; } ACtx;
static void a_done(void *ctx, IOReturn res, void *arg0) {
    ACtx *c = ctx; UInt32 n = (UInt32)(uintptr_t)arg0;
    if (c->in) log_in(c->w, c->pipe, c->buf, n, res, "BULKIN_ASYNC"); else logline("BULKOUT_ASYNC done ep=%02x ret=%08x", pipe_ep(c->w, c->pipe) & 0xff, res);
    if (c->cb) c->cb(c->refcon, res, arg0);
    free(c);
}
static IOReturn async_common(void *self, int slot, int in, UInt8 pipe, void *buf, UInt32 size, IOAsyncCallback1 cb, void *refcon) {
    W *w = self; ACtx *c = calloc(1, sizeof *c);
    c->cb = cb; c->refcon = refcon; c->w = w; c->pipe = pipe; c->buf = buf; c->in = in;
    if (!in) log_out(w, 0, pipe, buf, size, "BULKOUT_ASYNC"); else logline("BULKIN_ASYNC start ep=%02x len=%u", pipe_ep(w, pipe) & 0xff, size);
    IOReturn r = (IOReturn)orig(w, slot)((uintptr_t)w->real, pipe, (uintptr_t)buf, size, (uintptr_t)a_done, (uintptr_t)c, 0, 0);
    if (r) { logline("async submit failed ret=%08x", r); free(c); }
    return r;
}
static IOReturn h_ReadPipeAsync(void *s, UInt8 p, void *b, UInt32 n, IOAsyncCallback1 cb, void *rc) {
    return async_common(s, SLOT(IOUSBInterfaceInterface, ReadPipeAsync), 1, p, b, n, cb, rc);
}
static IOReturn h_WritePipeAsync(void *s, UInt8 p, void *b, UInt32 n, IOAsyncCallback1 cb, void *rc) {
    return async_common(s, SLOT(IOUSBInterfaceInterface, WritePipeAsync), 0, p, b, n, cb, rc);
}

// ---- generic per-slot logger for everything else ----
#define G(N) static uintptr_t g##N(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g_, uintptr_t h) { \
    W *w = (W *)a; uintptr_t r = orig(w, N)((uintptr_t)w->real, b, c, d, e, f, g_, h); \
    logline("CALL kind=%s slot=%d args=%lx,%lx,%lx,%lx ret=%lx", w->kind ? "intf" : "dev", N, (long)b, (long)c, (long)d, (long)e, (long)r); return r; }
#include "gslots.h"

static void **wrap(void **real, int kind) {
    if (!real) return real;
    W *w = calloc(1, sizeof *w); w->real = real; w->kind = kind;
    void **rv = *real;
    if (!have[kind]) { memcpy(origv[kind], rv, sizeof origv[kind]); have[kind] = 1; }
    w->vtbl = calloc(NSLOT, sizeof(void *));
    for (int i = 0; i < NSLOT; i++) w->vtbl[i] = (i < 4 ? (void *)rv[i] : gtab[i]); // keep IUnknown slots untouched
    if (kind == KDEV) {
        w->vtbl[SLOT(IOUSBDeviceInterface, DeviceRequest)] = h_DeviceRequest;
        w->vtbl[SLOT(IOUSBDeviceInterface, DeviceRequestTO)] = h_DeviceRequestTO;
    } else {
        w->vtbl[SLOT(IOUSBInterfaceInterface, ControlRequest)] = h_ControlRequest;
        w->vtbl[SLOT(IOUSBInterfaceInterface182, ControlRequestTO)] = h_ControlRequestTO;
        w->vtbl[SLOT(IOUSBInterfaceInterface, ReadPipe)] = h_ReadPipe;
        w->vtbl[SLOT(IOUSBInterfaceInterface, ReadPipeTO)] = h_ReadPipeTO;
        w->vtbl[SLOT(IOUSBInterfaceInterface, WritePipe)] = h_WritePipe;
        w->vtbl[SLOT(IOUSBInterfaceInterface, WritePipeTO)] = h_WritePipeTO;
        w->vtbl[SLOT(IOUSBInterfaceInterface, ReadPipeAsync)] = h_ReadPipeAsync;
        w->vtbl[SLOT(IOUSBInterfaceInterface, WritePipeAsync)] = h_WritePipeAsync;
    }
    // Slots 0-3 (reserved, QueryInterface, AddRef, Release) call straight into the real object, so they must
    // receive the real self; QueryInterface/AddRef/Release are rare enough that we forward via generic only
    // for slots >= 4. Replace 1-3 with thin forwarders:
    return (void **)w; // `self` seen by the app is &w->vtbl == w
}
// IUnknown forwarders (slots 1-3 get the real self)
typedef HRESULT (*qi_t)(void *, CFUUIDBytes, LPVOID *);
static HRESULT u_qi(void *self, CFUUIDBytes id, LPVOID *out) { W *w = self; return ((qi_t)origv[w->kind][1])(w->real, id, out); }
static ULONG u_addref(void *self) { W *w = self; return ((ULONG(*)(void *))origv[w->kind][2])(w->real); }
static ULONG u_release(void *self) { W *w = self; return ((ULONG(*)(void *))origv[w->kind][3])(w->real); }

// ---- plug-in interface interposition ----
static qi_t real_plug_qi[2];
typedef struct { void **plug; int kind; } PK;
static PK pks[64]; static int npk;
static HRESULT plug_qi(void *self, CFUUIDBytes id, LPVOID *out) {
    int kind = KDEV;
    for (int i = 0; i < npk; i++) if ((void **)self == pks[i].plug) kind = pks[i].kind;
    HRESULT r = real_plug_qi[kind](self, id, out);
    if (!r && out && *out) {
        // after the first wrap, point wrappers' slots 1-3 at the forwarders
        void **wo = wrap((void **)*out, kind);
        W *w = (W *)wo; w->vtbl[1] = u_qi; w->vtbl[2] = u_addref; w->vtbl[3] = u_release;
        *out = wo;
        logline("OBJECT kind=%s wrapped", kind ? "intf" : "dev");
    }
    return r;
}

static IOReturn my_IOCreatePlugIn(io_service_t svc, CFUUIDRef type, CFUUIDRef iface, IOCFPlugInInterface ***theInterface, SInt32 *score) {
    IOReturn r = IOCreatePlugInInterfaceForService(svc, type, iface, theInterface, score);
    if (!r && theInterface && *theInterface && npk < 64) {
        int kind = CFEqual(type, kIOUSBInterfaceUserClientTypeID) ? KINTF : KDEV;
        IOCFPlugInInterface **p = *theInterface;
        pks[npk].plug = (void **)p; pks[npk].kind = kind; npk++;
        if (!real_plug_qi[kind]) real_plug_qi[kind] = (qi_t)(*p)->QueryInterface;
        // patch this plug-in object's vtable entry in a private copy so the app's QueryInterface comes to us
        static IOCFPlugInInterface copy[64]; static int nc;
        IOCFPlugInInterface *c = &copy[nc++ % 64]; *c = **p; c->QueryInterface = (void *)plug_qi;
        // the object stays the same pointer; only its vtable pointer changes
        *(IOCFPlugInInterface **)p = c;
        logline("PLUGIN kind=%s", kind ? "intf" : "dev");
    }
    return r;
}
struct interpose { const void *replacement, *replacee; };
__attribute__((used)) static struct interpose ip[] __attribute__((section("__DATA,__interpose"))) = {
    { (const void *)my_IOCreatePlugIn, (const void *)IOCreatePlugInInterfaceForService },
};

__attribute__((constructor)) static void spy_init(void) {
    clock_gettime(CLOCK_MONOTONIC, &t0);
    const char *path = getenv("USBSPY_LOG"); char def[64];
    if (!path) { snprintf(def, sizeof def, "usbspy_%d.log", getpid()); path = def; }
    spylog = fopen(path, "w"); if (!spylog) spylog = stderr;
    full = getenv("USBSPY_FULL") != NULL;
    init_gtab();
    logline("usbspy loaded pid=%d", getpid());
}
