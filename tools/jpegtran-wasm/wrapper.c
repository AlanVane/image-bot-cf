/*
 * jpegtran -optimize 的最小 C 封装（任务 2 / DESIGN §11-2）。
 *
 * 语义 = `jpegtran -optimize -copy none`：读 JPEG → DCT 系数域透传 →
 * 以 optimize_coding=TRUE 重写（Huffman 表重优化）；不拷贝任何标记段
 * （元数据剥离由 src/optimize/jpeg.ts 先行处理，这里天然 drop markers）。
 * 不解码/重编码像素 → 严格无损。
 *
 * 错误处理：libjpeg 默认错误即 exit——必须 setjmp 兜底，损坏文件只返回错误码，
 * 绝不能 trap（workerd isolate 会被杀）。
 */
/* 注意头文件顺序：jpeglib.h 依赖 stdio.h 的 FILE 与 stddef.h 的 size_t，
 * 但自己不包含它们（libjpeg 惯例）。 */
#include <stdio.h>
#include <stddef.h>
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>

#include <jpeglib.h>

struct jmp_err {
  struct jpeg_error_mgr pub;
  jmp_buf jmp;
};

/* 错误现场（诊断用，export getter） */
int g_err_phase = 0;   /* 1=src 2=dst */
int g_err_code = 0;

int get_last_error(int *phase) {
  *phase = g_err_phase;
  return g_err_code;
}

static void jmp_error_exit(j_common_ptr cinfo) {
  struct jmp_err *e = (struct jmp_err *)cinfo->err;
  g_err_code = cinfo->err->msg_code;
  longjmp(e->jmp, 1);
}

/* 返回 0 成功（out/out_len 由调用方 free）；1 = 输入非法；2 = 写阶段失败；3 = 内部失败。 */
int jpeg_optimize_huffman(const unsigned char *in, int in_len,
                          unsigned char **out, int *out_len) {
  struct jpeg_decompress_struct src;
  struct jpeg_compress_struct dst;
  struct jmp_err src_err, dst_err;
  unsigned char *buf = NULL;
  unsigned long buflen = 0;
  jvirt_barray_ptr *coefs;
  int rc = 3;

  g_err_phase = 1;
  g_err_code = 0;
  src.err = jpeg_std_error(&src_err.pub);
  src_err.pub.error_exit = jmp_error_exit;
  if (setjmp(src_err.jmp)) {
    jpeg_destroy_decompress(&src);
    return 1;
  }
  jpeg_create_decompress(&src);
  jpeg_mem_src(&src, in, (unsigned long)in_len);
  if (jpeg_read_header(&src, TRUE) != JPEG_HEADER_OK) {
    jpeg_destroy_decompress(&src);
    return 1;
  }

  g_err_phase = 2;
  dst.err = jpeg_std_error(&dst_err.pub);
  dst_err.pub.error_exit = jmp_error_exit;
  if (setjmp(dst_err.jmp)) {
    jpeg_destroy_compress(&dst);
    jpeg_destroy_decompress(&src);
    if (buf) free(buf);
    return 2;
  }
  jpeg_create_compress(&dst);
  jpeg_mem_dest(&dst, &buf, &buflen);

  /* 顺序要紧：jpeg_read_coefficients 之后 src.output_width 才有值，
   * jpeg_copy_critical_parameters 会把它拷成 dst.jpeg_width——先拷会是 0，
   * 随后 jcmaster 的"空图"检查直接失败（实测教训）。与 jpegtran.c 同序。 */
  coefs = jpeg_read_coefficients(&src);
  jpeg_copy_critical_parameters(&src, &dst);
  dst.optimize_coding = TRUE; /* ← jpegtran -optimize 的本体 */
  jpeg_write_coefficients(&dst, coefs);
  jpeg_finish_compress(&dst);
  jpeg_finish_decompress(&src);

  *out = (unsigned char *)malloc(buflen);
  if (*out) {
    memcpy(*out, buf, buflen);
    *out_len = (int)buflen;
    rc = 0;
  }
  if (buf) free(buf);
  jpeg_destroy_compress(&dst);
  jpeg_destroy_decompress(&src);
  return rc;
}
