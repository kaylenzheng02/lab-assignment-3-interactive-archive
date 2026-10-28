import { useParams, Link } from "react-router";

function ImageDetail({ images }) {
  const { id } = useParams();
  const image = images.find((img) => img.id === Number(id));

  if (!image) {
    return (
      <div>
        <h1>Image not found</h1>
        <Link to="/">Back to board</Link>
      </div>
    );
  }

  return (
    <div className="detail">
      <Link to="/">← Back to board</Link>
      <img src={image.src} alt={image.title} />
      <h1>{image.title}</h1>
      <p>Tags: {image.tags.join(", ")}</p>
    </div>
  );
}

export default ImageDetail;
