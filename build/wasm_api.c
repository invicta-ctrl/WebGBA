/* WebGBA core glue: exposes mGBA (MPL-2.0) to JavaScript via WebAssembly. */
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

#include <mgba/core/core.h>
#include <mgba/core/blip_buf.h>
#include <mgba/core/cheats.h>
#include <mgba/core/serialize.h>
#include <mgba/core/log.h>
#include <mgba/gba/core.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/savedata.h>
#include <mgba-util/vfs.h>

#define VID_W 240
#define VID_H 160
#define SAVE_CAP 0x20000
#define SAMPLE_RATE 48000
#define AUDIO_CAP 8192
#define STATE_CAP (16 * 1024 * 1024)

static struct mCore* core = NULL;
static uint32_t* video = NULL;
static uint8_t* romCopy = NULL;
static uint8_t* biosCopy = NULL;
static size_t biosSize = 0;
static uint8_t* saveBuf = NULL;
static uint8_t* pendingSave = NULL;
static size_t pendingSaveSize = 0;
static int16_t audio[AUDIO_CAP * 2];
static int audioCount = 0;
static uint8_t* stateBuf = NULL;
static size_t stateLen = 0;

static void silentLog(struct mLogger* l, int category, enum mLogLevel level, const char* fmt, va_list args) {
	(void) l; (void) category; (void) level; (void) fmt; (void) args;
}
static struct mLogger silentLogger = { .log = silentLog, .filter = NULL };

static void unload(void) {
	if (core) {
		core->deinit(core);
		core = NULL;
	}
	free(romCopy); romCopy = NULL;
	free(saveBuf); saveBuf = NULL;
	free(video); video = NULL;
}

EMSCRIPTEN_KEEPALIVE void* wg_alloc(size_t n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void wg_free(void* p) { free(p); }

EMSCRIPTEN_KEEPALIVE void wg_set_bios(const uint8_t* data, size_t size) {
	free(biosCopy); biosCopy = NULL; biosSize = 0;
	if (data && size) {
		if (size != 16384) return;
		biosCopy = malloc(size);
		if (!biosCopy) return;
		memcpy(biosCopy, data, size);
		biosSize = size;
	}
}

EMSCRIPTEN_KEEPALIVE void wg_set_pending_save(const uint8_t* data, size_t size) {
	free(pendingSave); pendingSave = NULL; pendingSaveSize = 0;
	if (data && size) {
		if (size > SAVE_CAP) return;
		pendingSave = malloc(size);
		if (!pendingSave) return;
		memcpy(pendingSave, data, size);
		pendingSaveSize = size;
	}
}

EMSCRIPTEN_KEEPALIVE int wg_load_rom(const uint8_t* data, size_t size) {
	unload();
	romCopy = malloc(size);
	if (!romCopy) return 0;
	memcpy(romCopy, data, size);

	mLogSetDefaultLogger(&silentLogger);
	core = GBACoreCreate();
	if (!core) return 0;
	mCoreInitConfig(core, NULL);
	core->init(core);

	video = calloc(VID_W * VID_H, sizeof(uint32_t));
	if (!video) { unload(); return 0; }
	core->setVideoBuffer(core, (color_t*) video, VID_W);

	core->setAudioBufferSize(core, 2048);
	blip_set_rates(core->getAudioChannel(core, 0), core->frequency(core), SAMPLE_RATE);
	blip_set_rates(core->getAudioChannel(core, 1), core->frequency(core), SAMPLE_RATE);

	struct VFile* rom = VFileFromMemory(romCopy, size);
	if (!rom) { unload(); return 0; }
	if (!core->loadROM(core, rom)) {
		rom->close(rom);
		unload();
		return 0;
	}
	if (biosCopy) {
		struct VFile* bios = VFileFromMemory(biosCopy, biosSize);
		if (bios && !core->loadBIOS(core, bios, 0)) {
			bios->close(bios);
		}
	}
	saveBuf = malloc(SAVE_CAP);
	if (!saveBuf) { unload(); return 0; }
	memset(saveBuf, 0xFF, SAVE_CAP);
	if (pendingSave) {
		memcpy(saveBuf, pendingSave, pendingSaveSize);
	}
	struct VFile* sav = VFileFromMemory(saveBuf, SAVE_CAP);
	if (!sav) { unload(); return 0; }
	core->loadSave(core, sav);
	free(pendingSave); pendingSave = NULL; pendingSaveSize = 0;
	core->reset(core);
	return 1;
}

EMSCRIPTEN_KEEPALIVE void wg_reset(void) { if (core) core->reset(core); }

EMSCRIPTEN_KEEPALIVE void wg_set_keys(uint32_t keys) { if (core) core->setKeys(core, keys); }

EMSCRIPTEN_KEEPALIVE void wg_run_frame(void) {
	if (!core) return;
	core->runFrame(core);
	for (int i = 0; i < VID_W * VID_H; ++i) video[i] |= 0xFF000000u;
	blip_t* l = core->getAudioChannel(core, 0);
	blip_t* r = core->getAudioChannel(core, 1);
	int n = blip_read_samples(l, audio, AUDIO_CAP, 1);
	blip_read_samples(r, audio + 1, AUDIO_CAP, 1);
	audioCount = n;
}

EMSCRIPTEN_KEEPALIVE uint32_t* wg_video_ptr(void) { return video; }
EMSCRIPTEN_KEEPALIVE int16_t* wg_audio_ptr(void) { return audio; }
EMSCRIPTEN_KEEPALIVE int wg_audio_count(void) { return audioCount; }
EMSCRIPTEN_KEEPALIVE int wg_sample_rate(void) { return SAMPLE_RATE; }

EMSCRIPTEN_KEEPALIVE uint8_t* wg_save_ptr(void) { return saveBuf; }
EMSCRIPTEN_KEEPALIVE int wg_save_size(void) {
	if (!core) return 0;
	return (int) GBASavedataSize(&((struct GBA*) core->board)->memory.savedata);
}

EMSCRIPTEN_KEEPALIVE void wg_title(char* out) {
	if (core) core->getGameTitle(core, out); else out[0] = 0;
}

EMSCRIPTEN_KEEPALIVE int wg_state_save(void) {
	if (!core) return 0;
	stateLen = core->stateSize(core);
	if (!stateLen || stateLen > STATE_CAP) return 0;
	free(stateBuf);
	stateBuf = calloc(1, stateLen);
	if (!stateBuf) { stateLen = 0; return 0; }
	if (!core->saveState(core, stateBuf)) {
		return 0;
	}
	return (int) stateLen;
}
EMSCRIPTEN_KEEPALIVE uint8_t* wg_state_ptr(void) { return stateBuf; }

EMSCRIPTEN_KEEPALIVE int wg_state_load(const uint8_t* data, size_t size) {
	if (!core || !data || size > STATE_CAP || size != core->stateSize(core)) return 0;
	void* tmp = malloc(size);
	if (!tmp) return 0;
	memcpy(tmp, data, size);
	int ok = core->loadState(core, tmp) ? 1 : 0;
	free(tmp);
	return ok;
}

static struct mCheatSet* cheatSet(void) {
	struct mCheatDevice* dev = core->cheatDevice(core);
	if (mCheatSetsSize(&dev->cheats)) {
		return *mCheatSetsGetPointer(&dev->cheats, 0);
	}
	struct mCheatSet* set = dev->createSet(dev, NULL);
	mCheatAddSet(dev, set);
	return set;
}
EMSCRIPTEN_KEEPALIVE int wg_cheat_add(const char* line) {
	if (!core) return 0;
	return mCheatAddLine(cheatSet(), line, 0) ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE void wg_cheat_clear(void) {
	if (core) mCheatDeviceClear(core->cheatDevice(core));
}
