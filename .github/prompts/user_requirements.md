# Moiré: AI Image Manager - User Requirements Document

**Version:** 1.1

## 1. Introduction & Vision

Moiré is a personal, image-centric application designed for enthusiasts and creators of AI-generated art, particularly those using workflows like **ComfyUI**. The primary vision is to provide a sophisticated and visually pleasing platform for users to **browse, manage, and showcase their collections**. The application moves beyond simple folder-based organization, offering a powerful, tag-based system to categorize and find images based on their content, style, and generation parameters. For the collector, easy and intuitive organization is paramount to maintaining a curated gallery.

## 2. Target Users

The primary target user is an individual who actively generates AI art using tools like ComfyUI and has a large, growing collection of images they wish to organize, admire, and easily search through.

## 3. Goals

*   To provide an intuitive way to manage image libraries residing on a server.
*   To enable robust, flexible tagging of images, both manually and with AI assistance.
*   To offer powerful search and filtering capabilities based on tags and other metadata.
*   To present images in a clean, responsive, and **image-centric** interface that feels like a personal digital gallery.
*   To make the process of organizing a large, complex collection of AI art feel effortless and rewarding.

## 4. Functional Requirements (What the System Must Do)

### 4.1. Library Management

*   **FR1.1 - Add Library:** Users must be able to define a "Library" by specifying a root folder path on the server where the application is running (e.g., the output folder for a ComfyUI workflow).
*   **FR1.2 - Scan & Index Images:** Upon adding a library, or explicitly requesting a re-scan, the application must recursively scan the specified folder and all its subfolders for image files (e.g., .jpg, .png, .gif, .webp, .bmp). It must store essential metadata (like file path, name, size, dimensions, creation/modification dates) for each image.
    *   **FR1.2.1 - (Future) Read Workflow Data:** The application should be designed with the future capability to read embedded workflow data from AI-generated images (like those from ComfyUI), which could be used for advanced filtering.
*   **FR1.3 - List Libraries:** The application must display a list of all configured libraries, including their names and paths.
*   **FR1.4 - Select & View Library:** Users must be able to select a specific library from the list to view and manage its contained images.
*   **FR1.5 - Remove Library:** Users must be able to remove a library definition from the application's management. This action must *not* delete any actual image files from the server.
*   **FR1.6 - Re-scan Library:** Users must be able to trigger a re-scan of an existing library to discover new images or update metadata for existing ones.

### 4.2. Image Viewing & Navigation (Image-Centric Design)

*   **FR2.1 - Image Gallery View:** The application must display images from the currently selected context (e.g., all images, a specific library, or a search result) in a responsive, visually appealing grid or gallery format. The images themselves should be the primary focus.
*   **FR2.2 - Individual Image View:** Users must be able to click on an image thumbnail to see a larger, high-quality preview and its detailed information, including all associated tags. This view should feel immersive.
*   **FR2.3 - "All Images" View:** The application must provide a main gallery view that aggregates and displays all images from all configured libraries, serving as the user's complete collection showcase.
*   **FR2.4 - Browse by Tag/Category:** Users must be able to browse images grouped by existing tags or predefined categories (e.g., "Characters," "Styles," "Loras"). This view should present a prominent visual representation for each tag/category (e.g., a large, configurable thumbnail) and allow navigation to a dedicated view for that specific tag/category.
*   **FR2.5 - Specific Tag/Category View:** When a tag or category is selected, the application must display all images associated with that specific tag/category in an image gallery format.

### 4.3. Tagging System (Easy Organization)

*   **FR3.1 - Tag Storage:** The application must store all tags associated with images.
*   **FR3.2 - Manual Tagging (Add):** Users must be able to easily and quickly add new tags to an individual image.
*   **FR3.3 - Manual Tagging (Remove):** Users must be able to easily and quickly remove existing tags from an individual image.
*   **FR3.4 - AI Tag Inference:** The application must integrate with an external AI tag inference API to suggest tags for images.
*   **FR3.5 - Trigger AI Tagging:** Users must be able to manually trigger the AI tag inference process for a selected image or a batch of images.
*   **FR3.6 - Tag Suggestion & Confirmation:** The application must display suggested tags from the AI and allow the user to confirm, edit, or reject them before they are permanently saved.

### 4.4. Search & Filtering

*   **FR4.1 - Search Bar:** The application must include a prominent search bar.
*   **FR4.2 - Search by Tags:** Users must be able to type one or more tags into the search bar to find matching images.
*   **FR4.3 - Search Logic:** The search functionality must support both "AND" logic (find images matching *all* entered tags) and "OR" logic (find images matching *any* of the entered tags), selectable by the user.
*   **FR4.4 - Tag Autocompletion:** As the user types in the search bar or when manually adding tags, the application must suggest existing tags from the database for autocompletion.
*   **FR4.5 - Filter by Clicking Tags:** Users must be able to click on a displayed tag (e.g., under an image or in a tag list) to filter the current view to show only images with that tag.
*   **FR4.6 - Search by "No Tags":** Users should be able to find images that currently have no tags associated with them, to easily identify what needs organizing.

### 4.5. Image Actions (Batch & Individual)

*   **FR5.1 - Image Selection:** Users must be able to select multiple images in a gallery view.
*   **FR5.2 - Bulk Tagging:** Users must be able to add or remove tags to/from multiple selected images simultaneously.
*   **FR5.3 - Bulk AI Tagging:** Users must be able to trigger AI tag inference for multiple selected images.

## 6. Non-Functional Requirements (How Well the System Must Perform)

### 6.1. Usability & User Experience (UX)

*   **NFR1.1 - Image-Centric Design:** The application must feature a modern, clean, and aesthetically pleasing user interface where the artwork is the hero. UI elements should be unobtrusive but easily accessible.
*   **NFR1.2 - Responsiveness:** The application layout must adapt gracefully to different screen sizes (desktop, tablet).
*   **NFR1.3 - Intuitive Navigation:** Navigation between different sections (e.g., libraries, image views, search) must be clear and easy to understand.
*   **NFR1.4 - User Feedback:** The application must provide clear visual feedback for ongoing operations (e.g., loading spinners, progress bars for long-running tasks like scanning or bulk tagging, success/error notifications).
*   **NFR1.5 - Error Handling:** User-friendly error messages should be displayed for issues such as API failures, invalid folder paths, or image processing problems.

### 6.2. Performance

*   **NFR2.1 - Efficient Indexing:** The initial scanning and indexing of large image libraries should be performed efficiently.
*   **NFR2.2 - Fast Gallery Loading:** Image galleries must load and scroll smoothly, even when displaying a large number of thumbnails.
*   **NFR2.3 - Responsive Search:** Tag search and filtering operations must provide results quickly.

### 6.3. Reliability

*   **NFR3.1 - Robust File System Handling:** The application must handle scenarios where specified library paths are invalid, become inaccessible, or contain corrupted image files.
*   **NFR3.2 - External API Resilience:** The application must gracefully handle connection issues or errors when communicating with the external AI tag inference API.

## 7. External Interfaces

*   **EI1 - External AI Tagging API:** The system will interact with a user-provided HTTP endpoint for tag inference. This endpoint is expected to receive image data or a file path and return a structured list or CSV string of suggested tags.
*   **EI2 - Local File System:** The system will read image files and directory structures from the server's local file system. It will also write generated thumbnail image files to a designated directory on the server's file system.

## 8. Sidenote on Potential Technologies

*   **Indexing:** To provide the required search and metadata storage capabilities, a database like **MongoDB** is a strong candidate due to its flexible document structure, which is well-suited for storing varied metadata.
*   **Thumbnail Caching/Serving:** For efficient delivery of thumbnails to the user interface, an object storage solution like **MinIO** could be considered as a high-performance cache or serving layer, especially in larger-scale deployments. This is a suggestion for architectural consideration and not a strict requirement for an initial personal-use version.