#!/usr/bin/env python3
"""Explicit Linux x86_64 voice installation. Never runs during API startup."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
VENDOR=ROOT/'vendor'
SERVICE=ROOT/'apps/local-service'
WHISPER_VERSION='v1.9.5'
MODEL_NAME='ggml-large-v3-turbo-q5_0.bin'
MODEL_SHA256='394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
VAD_NAME='ggml-silero-v6.2.0.bin'
VAD_SHA256='2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'


def download(url, target, digest):
    if target.is_file():
        with target.open('rb') as source:
            if hashlib.file_digest(source,'sha256').hexdigest()==digest:return
        raise RuntimeError(f'Existing {target.name} has an unexpected checksum; inspect it before retrying.')
    temporary=target.with_suffix(target.suffix+'.part')
    try:
        with urllib.request.urlopen(url,timeout=120) as source,temporary.open('wb') as output:
            shutil.copyfileobj(source,output)
        with temporary.open('rb') as source:
            if hashlib.file_digest(source,'sha256').hexdigest()!=digest:raise RuntimeError('Download checksum mismatch')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    if platform.system()!='Linux' or platform.machine() not in ('x86_64','AMD64'):
        raise SystemExit('This installer targets Linux x86_64. Configure WHISPER_CPP_CLI, WHISPER_MODEL_PATH, FFMPEG_PATH and FFPROBE_PATH for your platform.')
    for program in ('git','cmake','g++'):
        if not shutil.which(program):raise SystemExit(f'Install {program} before running voice setup.')
    VENDOR.mkdir(exist_ok=True)
    whisper=VENDOR/'whisper.cpp'
    if not whisper.exists():subprocess.run(['git','clone','--depth','1','--branch',WHISPER_VERSION,'https://github.com/ggml-org/whisper.cpp.git',str(whisper)],check=True)
    tag=subprocess.check_output(['git','-C',str(whisper),'describe','--tags','--exact-match'],text=True).strip()
    if tag!=WHISPER_VERSION:raise SystemExit('Existing Whisper source is a different version; it was left unchanged.')
    cli=whisper/'build/bin/whisper-cli'
    if not cli.is_file():
        subprocess.run(['cmake','-S',str(whisper),'-B',str(whisper/'build'),'-DCMAKE_BUILD_TYPE=Release','-DGGML_CUDA=OFF','-DWHISPER_BUILD_TESTS=OFF'],check=True)
        subprocess.run(['cmake','--build',str(whisper/'build'),'--target','whisper-cli','-j','4'],check=True)
    binaries=list((VENDOR/'ffmpeg').glob('*/bin/ffmpeg'))
    if not binaries:
        with urllib.request.urlopen('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest',timeout=30) as response:release=json.load(response)
        asset=next(asset for asset in release['assets'] if asset['name']=='ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz')
        digest=asset.get('digest','')
        if not digest.startswith('sha256:'):raise RuntimeError('Release is missing a SHA-256 checksum')
        archive=VENDOR/'ffmpeg.tar.xz'
        download(asset['browser_download_url'],archive,digest.removeprefix('sha256:'))
        with tarfile.open(archive) as package:package.extractall(VENDOR/'ffmpeg',filter='data')
        binaries=list((VENDOR/'ffmpeg').glob('*/bin/ffmpeg'))
    ffmpeg=binaries[0]
    model=SERVICE/'models'/MODEL_NAME;model.parent.mkdir(exist_ok=True)
    download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'+MODEL_NAME,model,MODEL_SHA256)
    vad=SERVICE/'models'/VAD_NAME
    download('https://huggingface.co/ggml-org/whisper-vad/resolve/main/'+VAD_NAME,vad,VAD_SHA256)
    python=SERVICE/'.venv/bin/python'
    if not python.is_file():raise SystemExit('Create apps/local-service/.venv and install requirements-dev.txt first.')
    voices=SERVICE/'voices'
    if not (voices/'en_US-lessac-medium.onnx').is_file() or not (voices/'en_US-lessac-medium.onnx.json').is_file():
        subprocess.run([str(python),'-m','piper.download_voices','en_US-lessac-medium','--data-dir',str(voices)],env={**os.environ,'ORT_DISABLE_TELEMETRY':'1'},check=True)
    config={'WHISPER_CPP_CLI':str(cli),'WHISPER_MODEL_PATH':str(model),'WHISPER_VAD_MODEL_PATH':str(vad),'FFMPEG_PATH':str(ffmpeg),'FFPROBE_PATH':str(ffmpeg.with_name('ffprobe'))}
    for key,path in config.items():
        if not Path(path).is_file():raise RuntimeError(f'Missing configured file: {key}')
    (SERVICE/'.voice-config.json').write_text(json.dumps(config,indent=2)+'\n')
    print('Whisper.cpp, multilingual Turbo model, Silero speech detection, FFmpeg/FFprobe and Piper voice are installed. Restart the local companion.')


if __name__=='__main__':main()
