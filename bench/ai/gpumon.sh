#!/usr/bin/env bash
# usage: gpumon.sh <out.csv>  (runs until killed; 250 ms samples)
# columns: timestamp, util %, mem MiB, sm clock MHz, power W, temp C, pstate
exec nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used,clocks.sm,power.draw,temperature.gpu,pstate --format=csv,noheader,nounits -lms 250 > "$1"
