FROM ignite/shared:latest

# The minified hook-deployer bundle (ethereumjs EVM for flag derivation) is
# ~480 KB — far over the per-argument exec limit (MAX_ARG_STRLEN, 128 KiB on
# Linux), so argv injection ("node -e <bundle>") cannot work. The bundle is
# staged into .bundle/ by plugins/scripts/build-all.js and baked in here;
# core executes it installed-style (metadata.bundledInImage).
COPY .bundle/index.js /plugin/index.js

CMD ["sleep", "infinity"]
