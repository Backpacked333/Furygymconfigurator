# Denoiser weights

`rt_hdr_alb_nrm.tza` is the Open Image Denoise `RT` filter for HDR color guided by albedo and
normal buffers, from [RenderKit/oidn-weights](https://github.com/RenderKit/oidn-weights)
(Apache-2.0, see `LICENSE.txt`). SHA-256
`e586ef2ff48d7fbb7611986405220ed8fc5c13ca79bfc40be4dc742fbf959e1a`.

It is fetched only when a resting view is path traced, and run on the GPU by `oidn-web`.
