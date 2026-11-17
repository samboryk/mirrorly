#include "playfair/playfair.h"
static unsigned char g_msg3[164];
static unsigned char g_cipher[72];
static unsigned char g_out[16];
__attribute__((export_name("msg_ptr"))) unsigned char* msg_ptr(void){return g_msg3;}
__attribute__((export_name("cipher_ptr"))) unsigned char* cipher_ptr(void){return g_cipher;}
__attribute__((export_name("out_ptr"))) unsigned char* out_ptr(void){return g_out;}
__attribute__((export_name("decrypt"))) void decrypt(void){ playfair_decrypt(g_msg3, g_cipher, g_out); }
