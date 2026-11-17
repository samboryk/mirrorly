#include "aacdecoder_lib.h"
static HANDLE_AACDECODER h;
static unsigned char inbuf[2048];
static INT_PCM outbuf[4096];
__attribute__((export_name("in_ptr"))) unsigned char* in_ptr(void){return inbuf;}
__attribute__((export_name("out_ptr"))) INT_PCM* out_ptr(void){return outbuf;}
/* returns 0 on success */
__attribute__((export_name("init_eld"))) int init_eld(void){
  if (h) aacDecoder_Close(h);
  h = aacDecoder_Open(TT_MP4_RAW, 1);
  if (!h) return -1;
  UCHAR asc[4] = {0xF8,0xE8,0x50,0x00};
  UCHAR *conf[1] = {asc}; UINT len[1] = {4};
  if (aacDecoder_ConfigRaw(h, conf, len) != AAC_DEC_OK) return -2;
  aacDecoder_SetParam(h, AAC_CONCEAL_METHOD, 1);
  aacDecoder_SetParam(h, AAC_PCM_MAX_OUTPUT_CHANNELS, 2);
  aacDecoder_SetParam(h, AAC_PCM_MIN_OUTPUT_CHANNELS, 2);
  return 0;
}
/* decodes one frame of len bytes from inbuf; returns number of interleaved samples (frames*channels) or negative */
__attribute__((export_name("decode"))) int decode(int len){
  UCHAR *p[1] = {inbuf}; UINT sz[1] = {(UINT)len}; UINT valid = (UINT)len;
  if (aacDecoder_Fill(h, p, sz, &valid) != AAC_DEC_OK) return -1;
  AAC_DECODER_ERROR e = aacDecoder_DecodeFrame(h, outbuf, 4096, 0);
  if (e != AAC_DEC_OK) return -(int)e;
  CStreamInfo *si = aacDecoder_GetStreamInfo(h);
  return si->frameSize * si->numChannels;
}
