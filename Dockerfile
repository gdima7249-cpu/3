FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY faceless ./faceless
# config.toml, .env, secrets/, assets/, output/, data/ монтируются томами
ENTRYPOINT ["python", "-m", "faceless"]
CMD ["status"]
