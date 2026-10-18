#!/bin/bash

# Quick setup script for Moiré Docker environment

set -e

echo "🚀 Setting up Moiré with Docker Compose..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not available. Please install Docker Compose first."
    exit 1
fi

if [ ! -f .env ]; then
    echo "📝 Creating .env file from .env.example..."
    cp .env.example .env
    echo "✅ Created .env file. You can customize it if needed."
else
    echo "✅ .env file already exists."
fi

if [ ! -f docker-compose.override.yml ]; then
    echo "⚠️  No docker-compose.override.yml — mount your image folders into the"
    echo "   backend there (see docs/docker-guide.md) or it can't see any libraries."
fi

echo ""
echo "🐳 Starting Moiré (backend + frontend)..."
docker compose up --build -d

echo ""
echo "⏳ Waiting for the backend to become healthy..."
PORT="${MOIRE_BACKEND_PORT:-8000}"
healthy=false
for _ in {1..60}; do
    if curl -sf "http://localhost:${PORT}/health" > /dev/null; then
        healthy=true
        break
    fi
    sleep 2
done
docker compose ps
if [ "$healthy" != true ]; then
    echo "❌ Backend did not become healthy. Check: docker compose logs backend"
    exit 1
fi

echo ""
echo "🎉 Moiré should now be running!"
echo "  Frontend:     http://localhost:5173"
echo "  Backend API:  http://localhost:8000/api/v1  (docs: http://localhost:8000/docs)"
echo ""
echo "📝 To stop services: docker compose down"
echo "📝 To view logs:      docker compose logs -f"
