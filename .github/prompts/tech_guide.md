## Moiré: Architectural & Framework Guidelines

### 1. High-Level Architecture

The application will be built as a **monorepo** containing two distinct, decoupled applications:

1.  **Frontend Application:** A modern single-page application (SPA) responsible for all user interface and interaction.
2.  **Backend Application:** A robust API server responsible for all business logic, data persistence, and file system operations.

These two applications will communicate exclusively via a RESTful API. This separation allows for independent development, deployment, and scaling.

### 2. Recommended Technology Stack

| Category                | Technology                             | Justification                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Package Manager**     | **pnpm**                               | Fast, disk-space efficient, and enforces a strict `node_modules` structure that prevents phantom dependencies. Its workspace support is excellent for managing monorepos.                                                                                                                                                        |
| **Monorepo Tooling**    | **pnpm workspaces**                    | Built-in to pnpm, lightweight, and perfectly sufficient for managing the frontend and backend projects within a single repository without the overhead of more complex tools.                                                                                                                                                    |
| **Frontend Framework**  | **React** with **TypeScript**          | Industry-standard for building dynamic, component-based UIs. TypeScript provides essential type safety, improving code quality and developer experience.                                                                                                                                                                         |
| **Frontend UI/Styling** | **Shadcn UI** & **Tailwind CSS**       | **Primary Recommendation.** To achieve the "image-centric" and "collector showcase" vision, you need maximum control over the UI's look and feel. Shadcn provides beautifully designed, unstyled components that you own, and Tailwind CSS offers a powerful utility-first approach to build a truly custom and polished design. |
| **Frontend UI (Alt.)**  | **Chakra UI** or **Material UI (MUI)** | If speed of initial UI assembly is more critical than a fully custom design, these libraries provide pre-styled, ready-to-use components that can build a functional UI very quickly.                                                                                                                                            |
| **Frontend Build Tool** | **Vite**                               | Provides an extremely fast and modern development experience with instant server start and Hot Module Replacement (HMR).                                                                                                                                                                                                         |
| **Frontend State Mgt.** | **Zustand** or **React Context API**   | Start simple. Zustand is a minimal, fast state management library that's easy to adopt. React's built-in Context is suitable for non-complex global state. Avoid Redux for now.                                                                                                                                                  |
| **Backend Framework**   | **FastAPI** (Python)                   | Leverages your existing expertise for maximum development velocity. It's high-performance, includes automatic data validation and API documentation, and is perfect for building robust APIs.                                                                                                                                    |
| **Database**            | **MongoDB**                            | As suggested in the URD, its flexible document model is ideal for storing the varied metadata of images, libraries, and tags. `pymongo` is the standard Python driver.                                                                                                                                                           |
| **Image Processing**    | **Pillow** (Python)                    | The standard, robust library for all image manipulation tasks in Python, such as generating thumbnails.                                                                                                                                                                                                                          |

### 3. Monorepo File Structure (`pnpm` workspaces)

This structure keeps your frontend and backend code organized and independent while being managed under a single root project.

```
moire/
├── .git/
├── .gitignore             # Root gitignore for both Node.js and Python projects
├── packages/              # The directory containing all workspaces (your apps)
│   ├── frontend/          # The React + TypeScript + Shadcn UI application
│   │   ├── public/
│   │   ├── src/
│   │   │   ├── app/           # Core layout and routing setup
│   │   │   ├── components/    # Reusable UI components (e.g., ImageThumbnail, ImageGallery)
│   │   │   │   └── ui/        # --> This is where you'd place Shadcn UI components
│   │   │   ├── features/      # Feature-specific components/logic (e.g., Libraries, Tags)
│   │   │   ├── hooks/         # Custom React hooks
│   │   │   ├── lib/           # Utility functions, cn(), etc.
│   │   │   ├── services/      # API communication layer (Axios)
│   │   │   └── types/         # TypeScript type definitions (api.ts)
│   │   ├── .env.local       # Environment variables (e.g., API URL if not using proxy)
│   │   ├── package.json     # Frontend dependencies (React, Chakra, etc.)
│   │   ├── postcss.config.js # For Tailwind CSS
│   │   ├── tailwind.config.js # For Tailwind CSS
│   │   └── tsconfig.json
│   │
│   └── backend/           # The FastAPI application
│       ├── src/             # Python source code
│       │   ├── api/           # API Routers for different resources (libraries, images, tags)
│       │   ├── core/          # Core logic (config loading, logging)
│       │   ├── database/      # MongoDB connection and helper functions
│       │   ├── models/        # Pydantic models for request/response validation
│       │   ├── services/      # Business logic (file scanning, tag processing)
│       │   └── main.py        # Main FastAPI app instance and middleware setup
│       ├── .venv/           # Python virtual environment (add to .gitignore!)
│       ├── .env             # Backend environment variables (DB URI, API keys)
│       └── pyproject.toml   # Modern Python dependency management (e.g., with Poetry or PDM)
│
├── (MinIO)                # Thumbnails and originals stored in buckets: moire-thumbs, moire-originals
├── package.json           # Root package.json to manage workspaces & root scripts
└── pnpm-workspace.yaml    # Defines the root of the pnpm workspace
```

### 4. Setup & Workflow Guidelines

1.  **Initialization:**

    - Start by initializing the root of the project with `pnpm init`.
    - Create the `pnpm-workspace.yaml` file to define the `packages/*` path.
    - Initialize the frontend project inside `packages/frontend` using `pnpm create vite@latest . --template react-ts`.
    - Set up the Python virtual environment inside `packages/backend` (`python -m venv .venv`).

2.  **Dependency Management:**

    - Use `pnpm add <package>` within the `packages/frontend` directory for frontend dependencies.
    - Use `pip install <package>` (with the virtual environment activated) or your chosen Python package manager (like Poetry or PDM) for backend dependencies.

3.  **Development:**

    - Run two separate terminal instances for development:
      - **Terminal 1 (Frontend):** Navigate to `packages/frontend` and run the Vite dev server (`pnpm dev`).
      - **Terminal 2 (Backend):** Activate the virtual environment (`source packages/backend/.venv/bin/activate`) and run the Uvicorn dev server (`uvicorn moire.main:app --reload`).
    - **Recommendation:** Use a tool like `concurrently` in the root `package.json` to start both servers with a single command (`pnpm dev`).

4.  **Static Assets (Thumbnails):**
    - Thumbnails and originals are stored in MinIO buckets. Backend streams content from MinIO via `/images/:id/file` and `/images/:id/thumb`. Optionally, pre-signed URLs can be used in future to offload traffic from API.

This structure provides a robust and scalable foundation for building Moiré, aligning with modern development practices and leveraging your specific skillset and project vision.
